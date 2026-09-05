require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");

const passport = require("./src/config/passport");

const {
  testDatabaseConnection
} = require("./src/config/database");

const authRoutes = require("./src/routes/authRoutes");
const fileRoutes = require("./src/routes/fileRoutes");
const folderRoutes = require("./src/routes/folderRoutes");
const shareRoutes = require("./src/routes/shareRoutes");
const linkShareRoutes = require("./src/routes/linkShareRoutes");
const dashboardRoutes = require("./src/routes/dashboardRoutes");

const {
  apiLimiter,
  uploadLimiter
} = require("./src/middleware/security");

const app = express();

const PORT = process.env.PORT || 8080;

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: "cross-origin"
    }
  })
);

app.use(
  cors({
    origin:
      process.env.CORS_ORIGIN ||
      "http://localhost:3000",
    credentials: true
  })
);

app.use(express.json({ limit: "2mb" }));

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(cookieParser());

app.use(passport.initialize());

app.use(apiLimiter);

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "CloudNest backend is running",
    timestamp: new Date().toISOString()
  });
});

app.use(
  "/api/auth",
  authRoutes
);

app.use(
  "/api/files/init",
  uploadLimiter
);

app.use(
  "/api/files",
  fileRoutes
);

app.use(
  "/api/folders",
  folderRoutes
);

app.use(
  "/api/shares",
  shareRoutes
);

app.use(
  "/api",
  linkShareRoutes
);

app.use(
  "/api",
  dashboardRoutes
);

app.use((req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "Route not found"
    }
  });
});

app.use((error, req, res, next) => {
  console.error(
    "Unhandled server error:",
    error
  );

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
    console.error(
      "Unable to start server:",
      error
    );

    process.exit(1);
  }
};

startServer();