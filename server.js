
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

const rooms = {};

const COLORS = ["#ff4d4d", "#4da6ff", "#55dd77", "#ffcc44"];

const GRID_WIDTH = 30;
const GRID_HEIGHT = 20;

const FOOD_COUNT = 5;
const MIN_OBSTACLES = 3;
const MAX_OBSTACLES = 5;

const SPEEDS = {
    slow: 300,
    normal: 200,
    fast: 120
};

const START_POSITIONS = [
    { x: 5, y: 5, dir: "right" },
    { x: 24, y: 5, dir: "left" },
    { x: 5, y: 15, dir: "right" },
    { x: 24, y: 15, dir: "left" }
];

const DIRECTIONS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
};

io.on("connection", socket => {

    console.log("Player connected:", socket.id);

    // CREATE ROOM

    socket.on("createRoom", (playerName, callback) => {

        let roomCode;

        do {
            roomCode = Math.random()
                .toString(36)
                .substring(2, 7)
                .toUpperCase();
        } while (rooms[roomCode]);

        rooms[roomCode] = {
            players: [],
            host: socket.id,
            started: false,
            gameOver: false,
            winner: null,
            food: null,
            foods: [],
            obstacles: [],
            speed: "normal",
            interval: null
        };

        joinRoom(socket, roomCode, playerName, callback);
    });

    // JOIN ROOM

    socket.on("joinRoom", ({ roomCode, playerName }, callback) => {
        joinRoom(socket, roomCode, playerName, callback);
    });

    // CHANGE SPEED - HOST ONLY

    socket.on("setGameSpeed", (speed, callback) => {

        const roomCode = getPlayerRoom(socket.id);
        const room = rooms[roomCode];

        if (!room) {
            return callback?.({
                success: false,
                message: "Room not found."
            });
        }

        if (room.host !== socket.id) {
            return callback?.({
                success: false,
                message: "Only the host can change the speed."
            });
        }

        if (room.started) {
            return callback?.({
                success: false,
                message: "The game has already started."
            });
        }

        if (!SPEEDS[speed]) {
            return callback?.({
                success: false,
                message: "Invalid speed."
            });
        }

        room.speed = speed;

        io.to(roomCode).emit("speedUpdate", speed);

        callback?.({
            success: true,
            speed
        });
    });

    // START GAME

    socket.on("startGame", callback => {

        const roomCode = getPlayerRoom(socket.id);
        const room = rooms[roomCode];

        if (!room) {
            return callback?.({
                success: false,
                message: "Room not found."
            });
        }

        if (room.host !== socket.id) {
            return callback?.({
                success: false,
                message: "Only the host can start the game."
            });
        }

        if (room.players.length < 2) {
            return callback?.({
                success: false,
                message: "At least 2 players are needed."
            });
        }

        if (room.started) {
            return callback?.({
                success: false,
                message: "Game already started."
            });
        }

        startGame(roomCode);
        callback?.({ success: true });
    });

    // RETURN TO LOBBY - HOST ONLY

    socket.on("returnToLobby", callback => {

        const roomCode = getPlayerRoom(socket.id);
        const room = rooms[roomCode];

        if (!room) {
            return callback?.({
                success: false,
                message: "Room not found."
            });
        }

        if (room.host !== socket.id) {
            return callback?.({
                success: false,
                message: "Only the host can return the room to the lobby."
            });
        }

        if (!room.gameOver) {
            return callback?.({
                success: false,
                message: "The game is not finished yet."
            });
        }

        if (room.interval) {
            clearInterval(room.interval);
            room.interval = null;
        }

        room.started = false;
        room.gameOver = false;
        room.winner = null;
        room.food = null;
        room.foods = [];
        room.obstacles = [];

        room.players.forEach(player => {
            player.alive = true;
            player.score = 0;
            player.snake = [];
            player.direction = "right";
            player.nextDirection = "right";
        });

        io.to(roomCode).emit("returnToLobby");
        io.to(roomCode).emit("roomUpdate", room.players);
        io.to(roomCode).emit("speedUpdate", room.speed);

        callback?.({ success: true });
    });

    // CHANGE DIRECTION

    socket.on("changeDirection", direction => {

        const roomCode = getPlayerRoom(socket.id);
        const room = rooms[roomCode];

        if (!room || !room.started || room.gameOver) return;

        const player = room.players.find(p => p.id === socket.id);

        if (!player || !player.alive) return;
        if (!DIRECTIONS[direction]) return;

        const current = DIRECTIONS[player.direction];
        const next = DIRECTIONS[direction];

        if (
            current.x + next.x === 0 &&
            current.y + next.y === 0
        ) {
            return;
        }

        player.nextDirection = direction;
    });

    // DISCONNECT

    socket.on("disconnect", () => {

        console.log("Player disconnected:", socket.id);

        const roomCode = getPlayerRoom(socket.id);

        if (!roomCode) return;

        const room = rooms[roomCode];

        room.players = room.players.filter(
            player => player.id !== socket.id
        );

        if (room.players.length === 0) {

            if (room.interval) {
                clearInterval(room.interval);
            }

            delete rooms[roomCode];
            return;
        }

        if (room.host === socket.id) {
            room.host = room.players[0].id;
        }

        if (room.started && !room.gameOver) {
            checkGameOver(roomCode);
            emitGameState(roomCode);
        }

        io.to(roomCode).emit("roomUpdate", room.players);
    });

});

// JOIN ROOM FUNCTION

function joinRoom(socket, roomCode, playerName, callback) {

    const room = rooms[roomCode];

    if (!room) {
        return callback?.({
            success: false,
            message: "Room not found!"
        });
    }

    if (room.started) {
        return callback?.({
            success: false,
            message: "Game already started!"
        });
    }

    if (room.players.length >= 4) {
        return callback?.({
            success: false,
            message: "Room is full!"
        });
    }

    const player = {
        id: socket.id,
        name: String(playerName || "Player").slice(0, 16),
        color: COLORS[room.players.length],
        alive: true,
        score: 0,
        snake: [],
        direction: "right",
        nextDirection: "right"
    };

    room.players.push(player);

    socket.join(roomCode);

    callback?.({
        success: true,
        roomCode,
        players: room.players,
        speed: room.speed
    });

    io.to(roomCode).emit("roomUpdate", room.players);
    io.to(roomCode).emit("speedUpdate", room.speed);
}

// FIND PLAYER ROOM

function getPlayerRoom(playerId) {

    return Object.keys(rooms).find(code =>
        rooms[code].players.some(player => player.id === playerId)
    );
}

// CHECK IF A POSITION IS OCCUPIED

function isPositionOccupied(room, x, y) {

    const snakeOccupied = room.players.some(player =>
        player.snake.some(segment =>
            segment.x === x && segment.y === y
        )
    );

    const obstacleOccupied = room.obstacles.some(obstacle =>
        obstacle.x === x && obstacle.y === y
    );

    const foodOccupied = room.foods.some(food =>
        food.x === x && food.y === y
    );

    return snakeOccupied || obstacleOccupied || foodOccupied;
}

// CREATE RANDOM OBSTACLES

function createObstacles(room) {

    const amount = Math.floor(
        Math.random() * (MAX_OBSTACLES - MIN_OBSTACLES + 1)
    ) + MIN_OBSTACLES;

    room.obstacles = [];

    while (room.obstacles.length < amount) {

        const x = Math.floor(Math.random() * GRID_WIDTH);
        const y = Math.floor(Math.random() * GRID_HEIGHT);

        if (!isPositionOccupied(room, x, y)) {

            room.obstacles.push({ x, y });

        }
    }
}

// CREATE ONE FOOD

function createFood(room) {

    let food;

    do {

        food = {
            x: Math.floor(Math.random() * GRID_WIDTH),
            y: Math.floor(Math.random() * GRID_HEIGHT)
        };

    } while (isPositionOccupied(room, food.x, food.y));

    return food;
}

// CREATE MULTIPLE FOOD

function createFoods(room) {

    room.foods = [];

    for (let i = 0; i < FOOD_COUNT; i++) {
        room.foods.push(createFood(room));
    }

    room.food = room.foods[0] || null;
}

// START GAME

function startGame(roomCode) {

    const room = rooms[roomCode];

    if (!room) return;

    room.started = true;
    room.gameOver = false;
    room.winner = null;

    room.players.forEach((player, index) => {

        const start = START_POSITIONS[index];

        player.alive = true;
        player.score = 0;
        player.direction = start.dir;
        player.nextDirection = start.dir;

        const step = DIRECTIONS[start.dir];

        player.snake = [
            { x: start.x, y: start.y },
            { x: start.x - step.x, y: start.y - step.y },
            { x: start.x - step.x * 2, y: start.y - step.y * 2 }
        ];
    });

    // Generate obstacles first, then food

    room.obstacles = [];
    room.foods = [];

    createObstacles(room);
    createFoods(room);

    emitGameState(roomCode);

    room.interval = setInterval(() => {
        gameTick(roomCode);
    }, SPEEDS[room.speed]);
}

// GAME TICK

function gameTick(roomCode) {

    const room = rooms[roomCode];

    if (!room || !room.started || room.gameOver) return;

    const candidates = [];

    room.players.forEach(player => {

        if (!player.alive) return;

        player.direction = player.nextDirection;

        const movement = DIRECTIONS[player.direction];
        const head = player.snake[0];

        candidates.push({
            player,
            head: {
                x: head.x + movement.x,
                y: head.y + movement.y
            }
        });
    });

    const deadPlayers = new Set();

    // WALL, OBSTACLE AND BODY COLLISIONS

    candidates.forEach(({ player, head }) => {

        // Wall collision

        if (
            head.x < 0 ||
            head.x >= GRID_WIDTH ||
            head.y < 0 ||
            head.y >= GRID_HEIGHT
        ) {
            deadPlayers.add(player.id);
        }

        // Obstacle collision

        room.obstacles.forEach(obstacle => {

            if (
                obstacle.x === head.x &&
                obstacle.y === head.y
            ) {
                deadPlayers.add(player.id);
            }
        });

        // Body collision

        room.players.forEach(other => {

            if (!other.alive) return;

            other.snake.forEach(segment => {

                if (
                    segment.x === head.x &&
                    segment.y === head.y
                ) {
                    deadPlayers.add(player.id);
                }
            });
        });
    });

    // HEAD-ON COLLISIONS

    for (let i = 0; i < candidates.length; i++) {

        for (let j = i + 1; j < candidates.length; j++) {

            const a = candidates[i];
            const b = candidates[j];

            if (
                a.head.x === b.head.x &&
                a.head.y === b.head.y
            ) {
                deadPlayers.add(a.player.id);
                deadPlayers.add(b.player.id);
            }

            const aOld = a.player.snake[0];
            const bOld = b.player.snake[0];

            if (
                a.head.x === bOld.x &&
                a.head.y === bOld.y &&
                b.head.x === aOld.x &&
                b.head.y === aOld.y
            ) {
                deadPlayers.add(a.player.id);
                deadPlayers.add(b.player.id);
            }
        }
    }

    // APPLY MOVEMENT AND FOOD COLLECTION

    candidates.forEach(({ player, head }) => {

        if (deadPlayers.has(player.id)) {
            player.alive = false;
            return;
        }

        player.snake.unshift(head);

        const foodIndex = room.foods.findIndex(food =>
            food.x === head.x && food.y === head.y
        );

        if (foodIndex !== -1) {

            player.score += 1;

            // Remove eaten food

            room.foods.splice(foodIndex, 1);

            // Spawn replacement food

            room.foods.push(createFood(room));

        } else {

            player.snake.pop();

        }
    });

    room.food = room.foods[0] || null;

    checkGameOver(roomCode);
    emitGameState(roomCode);
}

// CHECK WINNER

function checkGameOver(roomCode) {

    const room = rooms[roomCode];

    if (!room) return;

    const alivePlayers = room.players.filter(p => p.alive);

    if (alivePlayers.length <= 1) {

        room.gameOver = true;

        if (room.interval) {
            clearInterval(room.interval);
            room.interval = null;
        }

        room.winner = alivePlayers[0] || null;
    }
}

// SEND GAME STATE

function emitGameState(roomCode) {

    const room = rooms[roomCode];

    if (!room) return;

    const gameState = {

        width: GRID_WIDTH,
        height: GRID_HEIGHT,

        players: room.players.map(player => ({
            id: player.id,
            name: player.name,
            color: player.color,
            alive: player.alive,
            score: player.score,
            snake: player.snake
        })),

        // Keep food for compatibility with the previous HTML

        food: room.food,

        // New multiple food and obstacle data

        foods: room.foods,
        obstacles: room.obstacles,

        gameOver: room.gameOver,

        winner: room.winner
            ? {
                id: room.winner.id,
                name: room.winner.name,
                color: room.winner.color
            }
            : null
    };

    io.to(roomCode).emit("gameState", gameState);
}

server.listen(PORT, () => {
    console.log(`PORPIS ARCADE running at http://localhost:${PORT}`);
});
