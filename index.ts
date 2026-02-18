import express from "express"
import http from "http"
import { Server } from "socket.io"
import crypto from "crypto"

const app = express()
const server = http.createServer(app)

const allowedOrigins = [
  "http://localhost:3000",
  "https://xpzones.in",
  "https://www.xpzones.in",
  "https://xpzone.vercel.app"
]

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket", "polling"], // Prefer websocket for instant delivery, fall back to polling
  pingInterval: 25000,
  pingTimeout: 60000,
  connectTimeout: 20000
})

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Socket.IO server running" })
})

app.get("/health", (req, res) => {
  res.json({ status: "ok", connections: io.engine.clientsCount })
})

interface PlayerMMR {
  socketId: string
  name: string
  mmr: number
}

interface DraftState {
  picks: { pokemonId: string, pokemon: any, team: "blue" | "red", pickerId: string }[]
  bans: { pokemonId: string, pokemon: any, bannerId: string, banningTeam: "blue" | "red" }[]
  currentTurn: "blue" | "red"
  turnPhase: "waiting" | "ban" | "pick" | "complete"
  turnNumber: number
  playerSides: Map<string, "blue" | "red">
  bluePlayers: string[]
  redPlayers: string[]
  playersBanned: string[]
  playersPicked: string[]
  // MMR-based leader election (highest MMR = leader)
  playerMMRs: Map<string, { name: string, mmr: number }>
  blueLeader: string | null
  redLeader: string | null
  // Track how many bans each leader has made
  blueBanCount: number
  redBanCount: number
  minPlayersPerTeam: number
  // Current picker tracking for turn-based picking
  currentPickerIndex: { blue: number, red: number }
  pickOrder: string[] // Order of socket IDs for picking
  // Room code set by blue leader after draft
  roomCode?: string
  // Post-game voting
  gameStartTime: number | null
  votingActive: boolean
  votes: Map<string, "blue" | "red">
  votingEndTime: number | null
  winner: "blue" | "red" | "draw" | null
}

const teams: any[] = []
const draftStates: Map<string, DraftState> = new Map()

// Session and disconnection management
interface Session {
  sessionId: string
  socketId: string
  teamId: string | null
  playerName: string | null
  playerMMR: number | null
  side: "blue" | "red" | null
  socketCount: number
}

const sessions = new Map<string, Session>()
const disconnectTimeouts = new Map<string, NodeJS.Timeout>()
const GRACE_PERIOD = 5000 // 5 seconds

// Reusable helper to remove a player from a team and clean up state
function removePlayerFromTeam(sessionId: string, teamId: string) {
  const team = teams.find(t => t.id === teamId)
  if (!team) return

  team.members = team.members.filter((id: string) => id !== sessionId)

  const draftState = draftStates.get(teamId)
  if (draftState) {
    draftState.bluePlayers = draftState.bluePlayers.filter((id: string) => id !== sessionId)
    draftState.redPlayers = draftState.redPlayers.filter((id: string) => id !== sessionId)
    draftState.playerSides.delete(sessionId)
    draftState.playerMMRs.delete(sessionId)

    // Re-calc leaders if the disconnected player was a leader
    if (sessionId === draftState.blueLeader || sessionId === draftState.redLeader) {
      const blueLeaders = Array.from(draftState.playerMMRs.entries())
        .filter(([pId]) => draftState.bluePlayers.includes(pId))
        .sort((a, b) => b[1].mmr - a[1].mmr)
      draftState.blueLeader = blueLeaders[0]?.[0] || null

      const redLeaders = Array.from(draftState.playerMMRs.entries())
        .filter(([pId]) => draftState.redPlayers.includes(pId))
        .sort((a, b) => b[1].mmr - a[1].mmr)
      draftState.redLeader = redLeaders[0]?.[0] || null
    }

    io.to(teamId).emit("player-disconnected", {
      playerId: sessionId,
      bluePlayers: draftState.bluePlayers,
      redPlayers: draftState.redPlayers,
      playerMMRs: Object.fromEntries(draftState.playerMMRs),
      blueLeader: draftState.blueLeader,
      redLeader: draftState.redLeader
    })
  }

  if (team.members.length === 0) {
    teams.splice(teams.indexOf(team), 1)
    draftStates.delete(teamId)
    console.log(`Team removed: ${teamId}`)
  }
  io.to("lobby").emit("teams-sync", teams)
}

io.on("connection", (socket) => {
  const sessionId = socket.handshake.auth.sessionId
  console.log(`User Connected: ${socket.id} (Session: ${sessionId})`)

  if (sessionId) {
    // If there was a pending disconnect for this session, clear it
    if (disconnectTimeouts.has(sessionId)) {
      console.log(`Clearing disconnect timeout for session: ${sessionId}`)
      clearTimeout(disconnectTimeouts.get(sessionId)!)
      disconnectTimeouts.delete(sessionId)
    }

    // Update or create session
    let session = sessions.get(sessionId)
    if (session) {
      session.socketId = socket.id
      session.socketCount++
    } else {
      session = {
        sessionId,
        socketId: socket.id,
        teamId: null,
        playerName: null,
        playerMMR: null,
        side: null,
        socketCount: 1
      }
      sessions.set(sessionId, session)
    }

    // If session was already in a team, rejoin the room and sync state
    if (session.teamId) {
      socket.join(session.teamId)
      //      console.log(`Socket ${socket.id} auto-rejoined room ${session.teamId}`)

      const draftState = draftStates.get(session.teamId)
      if (draftState) {
        socket.emit("draft-state-sync", {
          ...draftState,
          playerSides: Object.fromEntries(draftState.playerSides),
          playerMMRs: Object.fromEntries(draftState.playerMMRs),
        })
      }
    }
  }

  socket.join("lobby")
  socket.emit("teams-sync", teams)
  console.log(`Initial teams-sync sent to ${socket.id}. Current teams: ${teams.length}`)

  socket.on("get-teams", () => {
    socket.emit("teams-sync", teams)
    console.log(`Manual teams-sync requested by ${socket.id}. Current teams: ${teams.length}`)
  })

  // Explicit session restoration from client
  socket.on("restore-session", (data) => {
    const { sessionId: sId, teamId, side, playerName, playerMMR } = data
    if (!sId) return

    let session = sessions.get(sId)
    if (!session) {
      session = {
        sessionId: sId,
        socketId: socket.id,
        teamId,
        side,
        playerName,
        playerMMR,
        socketCount: 1
      }
      sessions.set(sId, session)
    } else {
      session.socketId = socket.id
      session.socketCount++
      if (teamId) session.teamId = teamId
      if (side) session.side = side
      if (playerName) session.playerName = playerName
      if (playerMMR) session.playerMMR = playerMMR
    }

    if (session.teamId) {
      socket.join(session.teamId)
      //      console.log(`Session restored for ${sId} in team ${session.teamId}`)

      // Send current state
      const draftState = draftStates.get(session.teamId)
      if (draftState) {
        socket.emit("draft-state-sync", {
          ...draftState,
          playerSides: Object.fromEntries(draftState.playerSides),
          playerMMRs: Object.fromEntries(draftState.playerMMRs),
        })
      }
    }
  })

  socket.on("create-team", (teamData) => {
    const team = {
      id: crypto.randomUUID(),
      name: teamData.teamName,
      mode: teamData.gameMode,
      leaderSessionId: sessionId, // Use sessionId as leader ref
      createdAt: Date.now(),
      members: [sessionId], // Store sessionIds
      status: "waiting"
    }

    teams.push(team)

    // Update session
    const session = sessions.get(sessionId)
    if (session) session.teamId = team.id

    draftStates.set(team.id, {
      picks: [],
      bans: [],
      currentTurn: "blue",
      turnPhase: "waiting",
      turnNumber: 1,
      playerSides: new Map(),
      bluePlayers: [],
      redPlayers: [],
      playersBanned: [],
      playersPicked: [],
      playerMMRs: new Map(),
      blueLeader: null,
      redLeader: null,
      blueBanCount: 0,
      redBanCount: 0,
      minPlayersPerTeam: team.mode === "5v5" ? 5 : team.mode === "10v10" ? 10 : 5,
      currentPickerIndex: { blue: 0, red: 0 },
      pickOrder: [],
      // Voting fields
      gameStartTime: null,
      votingActive: false,
      votes: new Map(),
      votingEndTime: null,
      winner: null
    })

    socket.join(team.id)
    socket.to("lobby").emit("team-created", team)
    io.to("lobby").emit("teams-sync", teams)
    socket.emit("team-created-success", team)

    console.log("Team created:", team.name)
  })

  socket.on("join-team", (teamId) => {
    const team = teams.find((t) => t.id === teamId)
    if (!team) {
      socket.emit("team-join-failed", { reason: "not-found" })
      return
    }

    const totalCapacity = team.mode === "5v5" ? 10 : team.mode === "10v10" ? 20 : 10

    if (team.members.includes(sessionId)) {
      socket.emit("team-join-failed", { reason: "already-member" })
      return
    }

    if (team.members.length >= totalCapacity) {
      socket.emit("team-join-failed", { reason: "Room is full" })
      return
    }

    team.members.push(sessionId)

    const session = sessions.get(sessionId)
    if (session) session.teamId = team.id

    socket.to("lobby").emit("team-updated", team)
    io.to("lobby").emit("teams-sync", teams)
    socket.emit("team-join-success", team)
    socket.join(team.id)

    const draftState = draftStates.get(team.id)
    if (draftState) {
      socket.emit("draft-state-sync", {
        ...draftState,
        playerSides: Object.fromEntries(draftState.playerSides),
        playerMMRs: Object.fromEntries(draftState.playerMMRs),
      })
    }
  })

  socket.on("select-side", (data: { teamId: string, side: "blue" | "red", playerName: string, mmr: number }) => {
    const { teamId, side, playerName, mmr } = data
    const draftState = draftStates.get(teamId)
    const team = teams.find(t => t.id === teamId)

    if (!draftState || !team) return

    const maxPerSide = team.mode === "5v5" ? 5 : team.mode === "10v10" ? 10 : 5

    if (side === "blue" && draftState.bluePlayers.length >= maxPerSide) {
      socket.emit("side-select-failed", { reason: "Blue team is full" })
      return
    }

    if (side === "red" && draftState.redPlayers.length >= maxPerSide) {
      socket.emit("side-select-failed", { reason: "Red team is full" })
      return
    }

    // Use sessionId for all tracking
    draftState.bluePlayers = draftState.bluePlayers.filter(id => id !== sessionId)
    draftState.redPlayers = draftState.redPlayers.filter(id => id !== sessionId)

    if (side === "blue") {
      draftState.bluePlayers.push(sessionId)
    } else {
      draftState.redPlayers.push(sessionId)
    }
    draftState.playerSides.set(sessionId, side)

    const session = sessions.get(sessionId)
    if (session) {
      session.side = side
      session.playerName = playerName
      session.playerMMR = mmr
    }

    const playerMmr = mmr || 1000
    draftState.playerMMRs.set(sessionId, { name: playerName, mmr: playerMmr })

    const updateLeaders = () => {
      if (draftState.bluePlayers.length > 0) {
        let highestBlueMMR = -1
        let blueLeaderId: string | null = null
        draftState.bluePlayers.forEach(pId => {
          const playerData = draftState.playerMMRs.get(pId)
          if (playerData && playerData.mmr > highestBlueMMR) {
            highestBlueMMR = playerData.mmr
            blueLeaderId = pId
          }
        })
        draftState.blueLeader = blueLeaderId
      }

      if (draftState.redPlayers.length > 0) {
        let highestRedMMR = -1
        let redLeaderId: string | null = null
        draftState.redPlayers.forEach(pId => {
          const playerData = draftState.playerMMRs.get(pId)
          if (playerData && playerData.mmr > highestRedMMR) {
            highestRedMMR = playerData.mmr
            redLeaderId = pId
          }
        })
        draftState.redLeader = redLeaderId
      }
    }

    updateLeaders()

    const hasEnoughPlayers =
      draftState.bluePlayers.length >= draftState.minPlayersPerTeam &&
      draftState.redPlayers.length >= draftState.minPlayersPerTeam

    if (hasEnoughPlayers && draftState.turnPhase === "waiting") {
      draftState.turnPhase = "ban"
      draftState.currentTurn = "blue"

      // Update team status in the teams list for the lobby
      if (team) team.status = "drafting"
      io.to("lobby").emit("teams-sync", teams)

      io.to(teamId).emit("phase-changed", {
        phase: "ban",
        blueLeader: draftState.blueLeader,
        redLeader: draftState.redLeader,
      })
    }

    io.to(teamId).emit("player-side-selected", {
      playerId: sessionId, // Emit sessionId instead of socketId
      playerName,
      playerMMR: playerMmr,
      side,
      bluePlayers: draftState.bluePlayers,
      redPlayers: draftState.redPlayers,
      playerMMRs: Object.fromEntries(draftState.playerMMRs),
      blueLeader: draftState.blueLeader,
      redLeader: draftState.redLeader,
      turnPhase: draftState.turnPhase
    })

    socket.emit("side-select-success", { side, isLeader: sessionId === draftState.blueLeader || sessionId === draftState.redLeader })
  })

  socket.on("draft-pick", (data: { teamId: string, pokemon: any, team: "blue" | "red" }) => {
    const { teamId, pokemon, team: draftTeam } = data
    const draftState = draftStates.get(teamId)
    if (!draftState || draftState.turnPhase !== "pick") return

    const playerSide = draftState.playerSides.get(sessionId)
    if (!playerSide || playerSide !== draftState.currentTurn) return

    if (draftState.playersPicked.includes(sessionId)) return

    draftState.picks.push({
      pokemonId: pokemon.id,
      pokemon,
      team: draftTeam,
      pickerId: sessionId
    })

    draftState.playersPicked.push(sessionId)
    draftState.turnNumber++
    draftState.currentTurn = draftState.currentTurn === "blue" ? "red" : "blue"

    const totalPlayers = draftState.bluePlayers.length + draftState.redPlayers.length
    if (draftState.playersPicked.length >= totalPlayers) {
      draftState.turnPhase = "complete"

      // Update team status in the lobby
      const team = teams.find(t => t.id === teamId)
      if (team) team.status = "live"
      io.to("lobby").emit("teams-sync", teams)

      // Start the 20-minute game timer for voting
      draftState.gameStartTime = Date.now()
      const GAME_DURATION = 20 * 60 * 1000 // 20 minutes
      const VOTING_DURATION = 60 * 1000 // 60 seconds for voting

      setTimeout(() => {
        const ds = draftStates.get(teamId)
        if (ds && !ds.votingActive && !ds.winner) {
          ds.votingActive = true
          ds.votingEndTime = Date.now() + VOTING_DURATION
          io.to(teamId).emit("voting-started", {
            endTime: ds.votingEndTime,
            duration: VOTING_DURATION
          })

          // End voting after VOTING_DURATION
          setTimeout(() => {
            const finalDs = draftStates.get(teamId)
            if (finalDs && finalDs.votingActive) {
              finalDs.votingActive = false

              // Count votes
              let blueVotes = 0
              let redVotes = 0
              finalDs.votes.forEach((vote) => {
                if (vote === "blue") blueVotes++
                else if (vote === "red") redVotes++
              })

              if (blueVotes > redVotes) finalDs.winner = "blue"
              else if (redVotes > blueVotes) finalDs.winner = "red"
              else finalDs.winner = "draw"

              io.to(teamId).emit("voting-ended", {
                winner: finalDs.winner,
                blueVotes,
                redVotes
              })

              // Update team status
              const t = teams.find(t => t.id === teamId)
              if (t) t.status = "finished"
              io.to("lobby").emit("teams-sync", teams)
            }
          }, VOTING_DURATION)
        }
      }, GAME_DURATION)
    }

    io.to(teamId).emit("draft-pick-made", {
      pokemon,
      team: draftTeam,
      pickerId: sessionId,
      currentTurn: draftState.currentTurn,
      turnPhase: draftState.turnPhase,
      turnNumber: draftState.turnNumber,
      playersPicked: draftState.playersPicked,
      draftComplete: draftState.turnPhase === "complete"
    })
  })

  socket.on("draft-ban", (data: { teamId: string, pokemon: any }) => {
    const { teamId, pokemon } = data
    const draftState = draftStates.get(teamId)
    if (!draftState || draftState.turnPhase !== "ban") return

    const playerSide = draftState.playerSides.get(sessionId)
    if (!playerSide || playerSide !== draftState.currentTurn) return

    const isBlueLeader = playerSide === "blue" && sessionId === draftState.blueLeader
    const isRedLeader = playerSide === "red" && sessionId === draftState.redLeader

    if (!isBlueLeader && !isRedLeader) return

    const currentBanCount = playerSide === "blue" ? draftState.blueBanCount : draftState.redBanCount
    if (currentBanCount >= 3) return

    draftState.bans.push({
      pokemonId: pokemon.id,
      pokemon,
      bannerId: sessionId,
      banningTeam: playerSide
    })

    if (playerSide === "blue") draftState.blueBanCount++
    else draftState.redBanCount++

    const updatedBanCount = playerSide === "blue" ? draftState.blueBanCount : draftState.redBanCount
    if (updatedBanCount >= 3) {
      draftState.currentTurn = draftState.currentTurn === "blue" ? "red" : "blue"
    }

    const allBansComplete = draftState.blueBanCount >= 3 && draftState.redBanCount >= 3
    if (allBansComplete) {
      draftState.turnPhase = "pick"
      draftState.currentTurn = "blue"
      io.to(teamId).emit("phase-changed", {
        phase: "pick",
        message: "Ban phase complete!"
      })
    }

    io.to(teamId).emit("draft-ban-made", {
      pokemon,
      bannerId: sessionId,
      banningTeam: playerSide,
      currentTurn: draftState.currentTurn,
      turnPhase: draftState.turnPhase,
      blueBanCount: draftState.blueBanCount,
      redBanCount: draftState.redBanCount,
    })
  })

  socket.on("set-room-code", (data: { teamId: string, roomCode: string }) => {
    const { teamId, roomCode } = data
    const draftState = draftStates.get(teamId)
    if (!draftState || sessionId !== draftState.blueLeader || draftState.turnPhase !== "complete") return

    draftState.roomCode = roomCode
    io.to(teamId).emit("room-code-set", {
      roomCode: roomCode,
      setBy: sessionId
    })
  })

  // Handle post-game voting
  socket.on("submit-vote", (data: { teamId: string, vote: "blue" | "red" }) => {
    const { teamId, vote } = data
    const draftState = draftStates.get(teamId)

    if (!draftState || !draftState.votingActive) {
      socket.emit("vote-failed", { reason: "Voting is not active" })
      return
    }

    // Check if player is part of this game
    const playerSide = draftState.playerSides.get(sessionId)
    if (!playerSide) {
      socket.emit("vote-failed", { reason: "You are not part of this game" })
      return
    }

    // Register the vote (overwrites any previous vote)
    draftState.votes.set(sessionId, vote)

    // Count current votes
    let blueVotes = 0
    let redVotes = 0
    draftState.votes.forEach((v) => {
      if (v === "blue") blueVotes++
      else if (v === "red") redVotes++
    })

    // Broadcast updated vote counts
    io.to(teamId).emit("vote-update", {
      blueVotes,
      redVotes,
      totalVoters: draftState.bluePlayers.length + draftState.redPlayers.length,
      votedCount: draftState.votes.size
    })

    socket.emit("vote-success", { vote })
  })

  // Explicit leave-team event (immediate removal, no grace period)
  socket.on("leave-team", (data: { teamId: string }) => {
    const { teamId } = data
    console.log(`Player ${sessionId} explicitly leaving team ${teamId}`)
    removePlayerFromTeam(sessionId, teamId)

    const session = sessions.get(sessionId)
    if (session) {
      session.teamId = null
      session.side = null
    }
  })

  socket.on("disconnect", () => {
    if (!sessionId) return

    const session = sessions.get(sessionId)
    if (session) {
      session.socketCount--
      if (session.socketCount > 0) {
        console.log(`Socket disconnected for ${sessionId}, but ${session.socketCount} tabs still open. No cleanup scheduled.`)
        return
      }
    }

    console.log(`All sockets closed for session ${sessionId}. Starting ${GRACE_PERIOD}ms grace period...`)

    // Set a timeout to clean up the session if they don't reconnect
    const timeout = setTimeout(() => {
      console.log(`Cleaning up session after grace period: ${sessionId}`)

      const s = sessions.get(sessionId)
      if (s && s.teamId) {
        removePlayerFromTeam(sessionId, s.teamId)
      }
      sessions.delete(sessionId)
      disconnectTimeouts.delete(sessionId)
    }, GRACE_PERIOD)

    disconnectTimeouts.set(sessionId, timeout)
  })

  // Get player info for a specific team
  socket.on("get-player-info", (data: { teamId: string, playerId: string }) => {
    const { teamId, playerId } = data
    const draftState = draftStates.get(teamId)
    if (draftState) {
      const playerData = draftState.playerMMRs.get(playerId)
      const side = draftState.playerSides.get(playerId)
      socket.emit("player-info", {
        playerId,
        ...playerData,
        side,
        isLeader: playerId === draftState.blueLeader || playerId === draftState.redLeader
      })
    }
  })

  // Handle chat messages in draft room
  socket.on("draft-chat-message", (data: { teamId: string, message: string, senderName: string }) => {
    const { teamId, message, senderName } = data
    const draftState = draftStates.get(teamId)

    if (!draftState) return

    const senderSide = draftState.playerSides.get(sessionId)
    if (!senderSide) {
      socket.emit("chat-failed", { reason: "You must select a team before chatting" })
      return
    }

    const chatMessage = {
      id: `${sessionId}-${Date.now()}`,
      senderId: sessionId,
      senderName: senderName || `Player_${sessionId.slice(0, 4)}`,
      senderSide,
      message: message.slice(0, 500),
      timestamp: Date.now()
    }

    io.to(teamId).emit("draft-chat-received", chatMessage)
  })
})

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000

server.listen(
  {
    port: Number(PORT),
    host: "0.0.0.0",
  },
  () => {
    console.log(`Server listening on ${PORT}`)
  }
)