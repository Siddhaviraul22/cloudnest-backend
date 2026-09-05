const express = require("express");

const {
  initUpload,
  completeUpload,
  listFiles,
  getFile,
  downloadFile,
  updateFile,
  deleteFile,
  restoreFile,
  permanentDeleteFile,
  listTrash,
  starFile,
  unstarFile,
  listStarredFiles,
  listRecentFiles,
  listVersions
} = require("../controllers/fileController");

const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/init", authenticate, initUpload);

router.post(
  "/complete",
  authenticate,
  completeUpload
);

router.get(
  "/",
  authenticate,
  listFiles
);

router.get(
  "/trash",
  authenticate,
  listTrash
);

router.get(
  "/starred",
  authenticate,
  listStarredFiles
);

router.get(
  "/recent",
  authenticate,
  listRecentFiles
);

router.get(
  "/:id/download",
  authenticate,
  downloadFile
);

router.get(
  "/:id/versions",
  authenticate,
  listVersions
);

router.post(
  "/:id/restore",
  authenticate,
  restoreFile
);

router.post(
  "/:id/star",
  authenticate,
  starFile
);

router.delete(
  "/:id/star",
  authenticate,
  unstarFile
);

router.patch(
  "/:id",
  authenticate,
  updateFile
);

router.delete(
  "/:id/permanent",
  authenticate,
  permanentDeleteFile
);

router.delete(
  "/:id",
  authenticate,
  deleteFile
);

router.get(
  "/:id",
  authenticate,
  getFile
);

module.exports = router;