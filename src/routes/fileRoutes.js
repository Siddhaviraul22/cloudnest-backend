const express = require("express");

const {
  initUpload,
  completeUpload,
  getFile
} = require("../controllers/fileController");

const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/init", authenticate, initUpload);

router.post("/complete", authenticate, completeUpload);

router.get("/:id", authenticate, getFile);

module.exports = router;