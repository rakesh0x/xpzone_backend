import express from "express"
import http from "http"
import { Server } from "socket.io"
import crypto from "crypto"

const app = express()
const server = http.createServer(app)

const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
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
}

const teams: any[] = []
const draftStates: Map<string, DraftState> = new Map()

io.on("connection", (socket) => {
  console.log("User Connected:", socket.id)

  socket.join("lobby")
  socket.emit("teams-sync", teams)
  console.log("Current teams on connect:", teams)

  socket.on("create-team", (teamData) => {
    const team = {
      id: crypto.randomUUID(),
      name: teamData.teamName,
      mode: teamData.gameMode,
      leaderSocketId: socket.id,
      createdAt: Date.now(),
      members: [socket.id]
    }

    teams.push(team)
    
    // Initialize draft state for this team - START WITH WAITING PHASE
    draftStates.set(team.id, {
      picks: [],
      bans: [],
      currentTurn: "blue",
      turnPhase: "waiting", // Wait for enough players
      turnNumber: 1,
      playerSides: new Map(),
      bluePlayers: [],
      redPlayers: [],
      playersBanned: [],
      playersPicked: [],
      // MMR-based leader (highest MMR = leader, auto-selected)
      playerMMRs: new Map(),
      blueLeader: null,
      redLeader: null,
      blueBanCount: 0,
      redBanCount: 0,
      minPlayersPerTeam: team.mode === "5v5" ? 5 : team.mode === "10v10" ? 10 : 5,
      currentPickerIndex: { blue: 0, red: 0 },
      pickOrder: []
    })

    // Creator joins the team room
    socket.join(team.id)

    socket.to("lobby").emit("team-created", team)
    io.to("lobby").emit("teams-sync", teams)

    socket.emit("team-created-success", team)

    console.log("Team created:", team.name)
    console.log("Rooms after create:", Array.from(io.sockets.adapter.rooms.keys()))
  })

  socket.on("join-team", (teamId) => {
    const team = teams.find((t) => t.id === teamId)
    if (!team) {
      socket.emit("team-join-failed", { reason: "not-found" })
      return
    }

    // Total capacity is both teams combined (5v5 = 10 total, 10v10 = 20 total)
    const totalCapacity = team.mode === "5v5" ? 10 : team.mode === "10v10" ? 20 : 10

    if (team.members.includes(socket.id)) {
      socket.emit("team-join-failed", { reason: "already-member" })
      return
    }

    if (team.members.length >= totalCapacity) {
      socket.emit("team-join-failed", { reason: "Room is full (both teams are at capacity)" })
      return
    }

    team.members.push(socket.id)

    socket.to("lobby").emit("team-updated", team)
    io.to("lobby").emit("teams-sync", teams)

    socket.emit("team-join-success", team)

    socket.join(team.id)

    console.log(`Socket ${socket.id} joined team ${team.id}`)
    console.log("Rooms after join:", Array.from(io.sockets.adapter.rooms.keys()))
    
    // Send current draft state to the joining player (they need to select a side first)
    const draftState = draftStates.get(team.id)
    if (draftState) {
      socket.emit("draft-state-sync", {
        ...draftState,
        playerSides: Object.fromEntries(draftState.playerSides),
        playerMMRs: Object.fromEntries(draftState.playerMMRs),
        bluePlayers: draftState.bluePlayers,
        redPlayers: draftState.redPlayers,
        playersBanned: draftState.playersBanned,
        playersPicked: draftState.playersPicked
      })
    }
  })

  // Handle side selection with MMR
  socket.on("select-side", (data: { teamId: string, side: "blue" | "red", playerName: string, mmr: number }) => {
    const { teamId, side, playerName, mmr } = data
    const draftState = draftStates.get(teamId)
    const team = teams.find(t => t.id === teamId)
    
    if (!draftState || !team) {
      console.log("No draft state or team found for:", teamId)
      return
    }

    // Check capacity for the selected side
    const maxPerSide = team.mode === "5v5" ? 5 : team.mode === "10v10" ? 10 : 5
    
    if (side === "blue" && draftState.bluePlayers.length >= maxPerSide) {
      socket.emit("side-select-failed", { reason: "Blue team is full" })
      return
    }

    if (side === "red" && draftState.redPlayers.length >= maxPerSide) {
      socket.emit("side-select-failed", { reason: "Red team is full" })
      return
    }

    // Remove from previous side if switching
    draftState.bluePlayers = draftState.bluePlayers.filter(id => id !== socket.id)
    draftState.redPlayers = draftState.redPlayers.filter(id => id !== socket.id)

    // Add to selected side
    if (side === "blue") {
      draftState.bluePlayers.push(socket.id)
    } else {
      draftState.redPlayers.push(socket.id)
    }
    draftState.playerSides.set(socket.id, side)
    
    // Store player's MMR (use provided or generate random for demo)
    const playerMmr = mmr || Math.floor(Math.random() * 1000) + 1000 // Random 1000-2000 if not provided
    draftState.playerMMRs.set(socket.id, { name: playerName || `Player_${socket.id.slice(0, 4)}`, mmr: playerMmr })

    console.log(`Player ${socket.id} (${playerName}, MMR: ${playerMmr}) selected ${side} team in room ${teamId}`)
    console.log(`Blue players: ${draftState.bluePlayers.length}, Red players: ${draftState.redPlayers.length}`)

    // Recalculate leaders based on highest MMR
    const updateLeaders = () => {
      // Blue leader = highest MMR on blue team
      if (draftState.bluePlayers.length > 0) {
        let highestBlueMMR = -1
        let blueLeaderId: string | null = null
        draftState.bluePlayers.forEach(playerId => {
          const playerData = draftState.playerMMRs.get(playerId)
          if (playerData && playerData.mmr > highestBlueMMR) {
            highestBlueMMR = playerData.mmr
            blueLeaderId = playerId
          }
        })
        draftState.blueLeader = blueLeaderId
        console.log(`Blue leader: ${blueLeaderId} (MMR: ${highestBlueMMR})`)
      }

      // Red leader = highest MMR on red team
      if (draftState.redPlayers.length > 0) {
        let highestRedMMR = -1
        let redLeaderId: string | null = null
        draftState.redPlayers.forEach(playerId => {
          const playerData = draftState.playerMMRs.get(playerId)
          if (playerData && playerData.mmr > highestRedMMR) {
            highestRedMMR = playerData.mmr
            redLeaderId = playerId
          }
        })
        draftState.redLeader = redLeaderId
        console.log(`Red leader: ${redLeaderId} (MMR: ${highestRedMMR})`)
      }
    }
    
    updateLeaders()

    // Check if we have enough players to start ban phase
    const hasEnoughPlayers = 
      draftState.bluePlayers.length >= draftState.minPlayersPerTeam && 
      draftState.redPlayers.length >= draftState.minPlayersPerTeam
    
    if (hasEnoughPlayers && draftState.turnPhase === "waiting") {
      draftState.turnPhase = "ban"
      draftState.currentTurn = "blue" // Blue leader bans first
      console.log("Enough players! Starting ban phase. Leaders determined by MMR.")
      io.to(teamId).emit("phase-changed", { 
        phase: "ban",
        message: "Teams are ready! Ban phase starting. Leaders (highest MMR) ban 3 Pokémon each.",
        blueLeader: draftState.blueLeader,
        redLeader: draftState.redLeader,
        blueLeaderMMR: draftState.playerMMRs.get(draftState.blueLeader || ""),
        redLeaderMMR: draftState.playerMMRs.get(draftState.redLeader || "")
      })
    }

    // Broadcast to all players in the room
    io.to(teamId).emit("player-side-selected", {
      playerId: socket.id,
      playerName: playerName || `Player_${socket.id.slice(0, 4)}`,
      playerMMR: playerMmr,
      side,
      bluePlayers: draftState.bluePlayers,
      redPlayers: draftState.redPlayers,
      playerMMRs: Object.fromEntries(draftState.playerMMRs),
      blueLeader: draftState.blueLeader,
      redLeader: draftState.redLeader,
      turnPhase: draftState.turnPhase
    })

    // Confirm to the player
    socket.emit("side-select-success", { side, isLeader: socket.id === draftState.blueLeader || socket.id === draftState.redLeader })
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

  socket.on("draft-pick", (data: { teamId: string, pokemon: any, team: "blue" | "red" }) => {
    const { teamId, pokemon, team: draftTeam } = data
    const draftState = draftStates.get(teamId)
    
    if (!draftState) {
      console.log("No draft state found for team:", teamId)
      return
    }

    // Validate that we're in pick phase
    if (draftState.turnPhase !== "pick") {
      socket.emit("draft-action-failed", { reason: "We're still in ban phase! Please ban a Pokémon first." })
      return
    }

    // Validate that it's the correct team's turn
    const playerSide = draftState.playerSides.get(socket.id)
    if (!playerSide) {
      socket.emit("draft-action-failed", { reason: "You haven't selected a team yet" })
      return
    }

    if (playerSide !== draftState.currentTurn) {
      socket.emit("draft-action-failed", { reason: "It's not your team's turn" })
      return
    }

    // Check if this player has already picked
    if (draftState.playersPicked.includes(socket.id)) {
      socket.emit("draft-action-failed", { reason: "You have already picked a Pokémon! Wait for other players." })
      return
    }

    // Add to picks
    draftState.picks.push({
      pokemonId: pokemon.id,
      pokemon,
      team: draftTeam,
      pickerId: socket.id
    })

    // Mark this player as having picked
    draftState.playersPicked.push(socket.id)

    // Advance turn
    draftState.turnNumber++
    draftState.currentTurn = draftState.currentTurn === "blue" ? "red" : "blue"

    // Check if draft is complete (all players have picked)
    const totalPlayers = draftState.bluePlayers.length + draftState.redPlayers.length
    const draftComplete = draftState.playersPicked.length >= totalPlayers

    // Update turn phase - set to "complete" if all players have picked
    if (draftComplete) {
      draftState.turnPhase = "complete"
      console.log("Draft complete! All players have picked.")
    } else {
      draftState.turnPhase = "pick"
    }

    console.log(`Pokemon picked: ${pokemon.name} by ${draftTeam} team (${socket.id}) in room ${teamId}`)
    console.log(`Players picked: ${draftState.playersPicked.length}/${totalPlayers}, turnPhase: ${draftState.turnPhase}`)

    // Broadcast to all players in the room (including sender)
    io.to(teamId).emit("draft-pick-made", {
      pokemon,
      team: draftTeam,
      pickerId: socket.id,
      currentTurn: draftState.currentTurn,
      turnPhase: draftState.turnPhase,
      turnNumber: draftState.turnNumber,
      playersPicked: draftState.playersPicked,
      draftComplete
    })
  })

  // Handle Pokemon ban - ONLY LEADERS CAN BAN
  socket.on("draft-ban", (data: { teamId: string, pokemon: any }) => {
    const { teamId, pokemon } = data
    const draftState = draftStates.get(teamId)
    
    if (!draftState) {
      console.log("No draft state found for team:", teamId)
      return
    }

    // Validate that we're in ban phase
    if (draftState.turnPhase !== "ban") {
      socket.emit("draft-action-failed", { reason: "Ban phase is over! Please pick a Pokémon." })
      return
    }

    // Validate that it's the correct team's turn
    const playerSide = draftState.playerSides.get(socket.id)
    if (!playerSide) {
      socket.emit("draft-action-failed", { reason: "You haven't selected a team yet" })
      return
    }

    if (playerSide !== draftState.currentTurn) {
      socket.emit("draft-action-failed", { reason: "It's not your team's turn" })
      return
    }

    // ONLY LEADERS CAN BAN
    const isBlueLeader = playerSide === "blue" && socket.id === draftState.blueLeader
    const isRedLeader = playerSide === "red" && socket.id === draftState.redLeader
    
    if (!isBlueLeader && !isRedLeader) {
      socket.emit("draft-action-failed", { reason: "Only the team leader can ban Pokémon!" })
      return
    }

    // Check if leader has already banned 3 Pokémon
    const currentBanCount = playerSide === "blue" ? draftState.blueBanCount : draftState.redBanCount
    if (currentBanCount >= 3) {
      socket.emit("draft-action-failed", { reason: "You have already banned 3 Pokémon!" })
      return
    }

    // Add to bans
    draftState.bans.push({
      pokemonId: pokemon.id,
      pokemon,
      bannerId: socket.id,
      banningTeam: playerSide
    })

    // Increment ban count for this team's leader
    if (playerSide === "blue") {
      draftState.blueBanCount++
    } else {
      draftState.redBanCount++
    }

    console.log(`Pokemon banned: ${pokemon.name} by ${playerSide} leader (${socket.id}) in room ${teamId}`)
    console.log(`Blue bans: ${draftState.blueBanCount}/3, Red bans: ${draftState.redBanCount}/3`)

    // Check if current leader has finished their 3 bans
    const updatedBanCount = playerSide === "blue" ? draftState.blueBanCount : draftState.redBanCount
    
    if (updatedBanCount >= 3) {
      // Switch turn to other team
      draftState.currentTurn = draftState.currentTurn === "blue" ? "red" : "blue"
    }

    // Check if both teams have banned 3 each (total 6 bans)
    const allBansComplete = draftState.blueBanCount >= 3 && draftState.redBanCount >= 3
    
    if (allBansComplete) {
      // All bans complete, switch to pick phase
      draftState.turnPhase = "pick"
      draftState.currentTurn = "blue" // Reset to blue for pick phase
      console.log("Ban phase complete! Switching to pick phase.")
      io.to(teamId).emit("phase-changed", {
        phase: "pick",
        message: "Ban phase complete! Each player now picks their Pokémon."
      })
    }

    // Broadcast to all players in the room (including sender)
    io.to(teamId).emit("draft-ban-made", {
      pokemon,
      bannerId: socket.id,
      banningTeam: playerSide,
      currentTurn: draftState.currentTurn,
      turnPhase: draftState.turnPhase,
      turnNumber: draftState.turnNumber,
      blueBanCount: draftState.blueBanCount,
      redBanCount: draftState.redBanCount,
      allBansComplete: draftState.blueBanCount >= 3 && draftState.redBanCount >= 3
    })
  })

  socket.on("request-draft-state", (teamId: string) => {
    const draftState = draftStates.get(teamId)
    if (draftState) {
      // Ensure the socket is in the team room for broadcasts
      socket.join(teamId)
      
      socket.emit("draft-state-sync", {
        picks: draftState.picks,
        bans: draftState.bans,
        currentTurn: draftState.currentTurn,
        turnPhase: draftState.turnPhase,
        turnNumber: draftState.turnNumber,
        playerSides: Object.fromEntries(draftState.playerSides),
        playerMMRs: Object.fromEntries(draftState.playerMMRs),
        bluePlayers: draftState.bluePlayers,
        redPlayers: draftState.redPlayers,
        playersBanned: draftState.playersBanned,
        playersPicked: draftState.playersPicked,
        blueLeader: draftState.blueLeader,
        redLeader: draftState.redLeader,
        blueBanCount: draftState.blueBanCount,
        redBanCount: draftState.redBanCount,
        minPlayersPerTeam: draftState.minPlayersPerTeam,
        currentPickerIndex: draftState.currentPickerIndex,
        pickOrder: draftState.pickOrder,
        roomCode: draftState.roomCode || null
      })
    }
  })

  // Handle room code set by blue team leader
  socket.on("set-room-code", (data: { teamId: string, roomCode: string }) => {
    const { teamId, roomCode } = data
    console.log(`[set-room-code] Received from ${socket.id}:`, { teamId, roomCode })
    
    const draftState = draftStates.get(teamId)
    
    if (!draftState) {
      console.log(`[set-room-code] Failed: No draft state found for team ${teamId}`)
      socket.emit("room-code-failed", { reason: "No draft state found" })
      return
    }
    
    console.log(`[set-room-code] Draft state found. blueLeader: ${draftState.blueLeader}, socket.id: ${socket.id}, turnPhase: ${draftState.turnPhase}`)
    
    // Only blue team leader can set room code
    if (socket.id !== draftState.blueLeader) {
      console.log(`[set-room-code] Failed: Socket ${socket.id} is not blue leader (${draftState.blueLeader})`)
      socket.emit("room-code-failed", { reason: "Only blue team leader can set room code" })
      return
    }
    
    // Only allow setting room code when draft is complete
    if (draftState.turnPhase !== "complete") {
      console.log(`[set-room-code] Failed: Draft not complete (phase: ${draftState.turnPhase})`)
      socket.emit("room-code-failed", { reason: "Draft must be complete before setting room code" })
      return
    }
    
    // Store and broadcast room code
    draftState.roomCode = roomCode
    
    // Get all sockets in the room
    const roomSockets = io.sockets.adapter.rooms.get(teamId)
    console.log(`[set-room-code] Broadcasting to room ${teamId}. Sockets in room:`, roomSockets ? Array.from(roomSockets) : 'none')
    
    io.to(teamId).emit("room-code-set", {
      roomCode: roomCode,
      setBy: socket.id
    })
    console.log(`[set-room-code] Broadcast complete for room code: ${roomCode}`)
  })

  // Handle chat messages in draft room
  socket.on("draft-chat-message", (data: { teamId: string, message: string, senderName: string }) => {
    const { teamId, message, senderName } = data
    const draftState = draftStates.get(teamId)
    
    if (!draftState) {
      console.log("No draft state found for chat in team:", teamId)
      return
    }

    // Get sender's side
    const senderSide = draftState.playerSides.get(socket.id)
    if (!senderSide) {
      socket.emit("chat-failed", { reason: "You must select a team before chatting" })
      return
    }

    // Create chat message object
    const chatMessage = {
      id: `${socket.id}-${Date.now()}`,
      senderId: socket.id,
      senderName: senderName || `Player_${socket.id.slice(0, 4)}`,
      senderSide,
      message: message.slice(0, 500), // Limit message length
      timestamp: Date.now()
    }

    console.log(`Chat message in room ${teamId} from ${senderName} (${senderSide}): ${message}`)

    // Broadcast to all players in the draft room
    io.to(teamId).emit("draft-chat-received", chatMessage)
  })

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id)

    // Remove disconnected socket from any teams and cleanup empty 
    // teams are unchanged
    //iteration through each loop
    let changed = false
    for (let i = teams.length - 1; i >= 0; i--) {
      const t = teams[i]
      const idx = t.members.indexOf(socket.id)
      if (idx !== -1) {
        t.members.splice(idx, 1)
        changed = true
        
        // Also clean up from draft state
        const draftState = draftStates.get(t.id)
        if (draftState) {
          const wasInBlue = draftState.bluePlayers.includes(socket.id)
          const wasInRed = draftState.redPlayers.includes(socket.id)
          
          draftState.bluePlayers = draftState.bluePlayers.filter(id => id !== socket.id)
          draftState.redPlayers = draftState.redPlayers.filter(id => id !== socket.id)
          draftState.playerSides.delete(socket.id)
          draftState.playerMMRs.delete(socket.id)
          
          // Recalculate leaders if leader disconnected
          if (socket.id === draftState.blueLeader) {
            draftState.blueLeader = null
            if (draftState.bluePlayers.length > 0) {
              let highestMMR = -1
              draftState.bluePlayers.forEach(playerId => {
                const playerData = draftState.playerMMRs.get(playerId)
                if (playerData && playerData.mmr > highestMMR) {
                  highestMMR = playerData.mmr
                  draftState.blueLeader = playerId
                }
              })
            }
          }
          if (socket.id === draftState.redLeader) {
            draftState.redLeader = null
            if (draftState.redPlayers.length > 0) {
              let highestMMR = -1
              draftState.redPlayers.forEach(playerId => {
                const playerData = draftState.playerMMRs.get(playerId)
                if (playerData && playerData.mmr > highestMMR) {
                  highestMMR = playerData.mmr
                  draftState.redLeader = playerId
                }
              })
            }
          }
          
          // Broadcast player disconnected to team
          if (wasInBlue || wasInRed) {
            io.to(t.id).emit("player-disconnected", {
              playerId: socket.id,
              side: wasInBlue ? "blue" : "red",
              bluePlayers: draftState.bluePlayers,
              redPlayers: draftState.redPlayers,
              playerMMRs: Object.fromEntries(draftState.playerMMRs),
              blueLeader: draftState.blueLeader,
              redLeader: draftState.redLeader
            })
            console.log(`Player ${socket.id} removed from ${wasInBlue ? 'blue' : 'red'} team. Blue: ${draftState.bluePlayers.length}, Red: ${draftState.redPlayers.length}`)
          }
        }
        
        // if no members left, remove team
        if (t.members.length === 0) {
          teams.splice(i, 1)
          draftStates.delete(t.id)
          console.log(`Team removed: ${t.id}`)
        }
      }
    }

    if (changed) {
      io.to("lobby").emit("teams-sync", teams)
    }
  })
})

server.listen(4000, () => {
  console.log("Server listening on 4000")
})