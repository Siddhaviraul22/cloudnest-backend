require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const passport = require("./src/config/passport");

const {
  testDatabaseConnection
} = require("./src/config/database");

const authRoutes = require("./src/routes/authRoutes");
const fileRoutes = require("./src/routes/fileRoutes");

const app = express();

const PORT = process.env.PORT || 8080;

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    credentials: true
  })
);

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(cookieParser());

app.use(passport.initialize());

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "CloudNest backend is running",
    timestamp: new Date().toISOString()
  });
});

app.use("/api/auth", authRoutes);

app.use("/api/files", fileRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "Route not found"
    }
  });
});

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);

  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong"
    }
  });
});

const startServer = async () => {
  try {
    await testDatabaseConnection();

    app.listen(PORT, () => {
      console.log(
        `CloudNest backend running on http://localhost:${PORT}`
      );
    });
  } catch (error) {
    console.error("Unable to start server:", error);
    process.exit(1);
  }
};

startServer();