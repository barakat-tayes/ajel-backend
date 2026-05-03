const socketIo = require("socket.io");

let io;

const initSocket = (server) => {
    io = socketIo(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
        },
    });

    io.on("connection", (socket) => {
        console.log("🔌 Client connected:", socket.id);

        // Join rooms based on user type and ID
        socket.on("join", (data) => {
            const { userType, userId } = data;
            socket.join(`${userType}_${userId}`);
            console.log(`${userType} ${userId} joined room`);

            // If driver is available, join the public drivers room
            if (userType === "driver") {
                socket.join("drivers_available");
                if (data.province) {
                    socket.join(`drivers_available_${data.province}`);
                }
            }

            // Join admin room to receive location updates
            if (userType === "admin") {
                socket.join("admin_all");
            }
        });

        socket.on("leave_available", () => {
            socket.leave("drivers_available");
        });

        // Driver location updates
        socket.on("update_location", (data) => {
            const { driverId, lat, lng } = data;
            // Broadcast to nearby restaurants or admins
            io.to("admin_all").emit("driver_location_update", { driverId, lat, lng });
        });

        socket.on("disconnect", () => {
            console.log("🔌 Client disconnected:", socket.id);
        });
    });

    return io;
};

const getIO = () => {
    if (!io) {
        throw new Error("Socket.io not initialized");
    }
    return io;
};

// Notify specific user or group
const notifyUser = (userType, userId, event, data) => {
    if (io) {
        io.to(`${userType}_${userId}`).emit(event, data);
    }
};

// Notify all admins
const notifyAdmins = (event, data) => {
    if (io) {
        io.to("admin_all").emit(event, data);
    }
};

// Notify all available drivers
const notifyDrivers = (event, data) => {
    if (io) {
        io.to("drivers_available").emit(event, data);
    }
};

const notifyDriversByProvince = (province, event, data) => {
    if (io && province) {
        io.to(`drivers_available_${province}`).emit(event, data);
    }
};

module.exports = { initSocket, getIO, notifyUser, notifyAdmins, notifyDrivers, notifyDriversByProvince };
