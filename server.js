const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

const { testDatabaseConnection } = require("./src/config/database");

dotenv.config();

const app = express();

const PORT = process.env.PORT || 8080;

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    credentials: true
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "CloudNest backend is running",
    timestamp: new Date().toISOString()
  });
});

const startServer = async () => {
  await testDatabaseConnection();

  app.listen(PORT, () => {
    console.log(`CloudNest backend running on http://localhost:${PORT}`);
  });
};

startServer();