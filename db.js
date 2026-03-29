const mongoose = require("mongoose");

let isConnected = false;

async function connectDB() {
  if (isConnected) return;

  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || "tutor_agent",
  });

  isConnected = true;
  console.log("MongoDB connected:", mongoose.connection.host);

  mongoose.connection.on("disconnected", () => {
    console.warn(" MongoDB disconnected. Reconnecting...");
    isConnected = false;
  });

  mongoose.connection.on("error", (err) => {
    console.error(" MongoDB error:", err.message);
  });
}

module.exports = connectDB;