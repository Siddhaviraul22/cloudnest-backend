const express = require("express");

const {
  createFolder,
  getFolder,
  getRootChildren,
  updateFolder,
  deleteFolder,
  restoreFolder,
  listTrashFolders
} = require("../controllers/folderController");

const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();

router.post(
  "/",
  authenticate,
  createFolder
);

router.get(
  "/root/children",
  authenticate,
  getRootChildren
);

router.get(
  "/trash",
  authenticate,
  listTrashFolders
);

router.get(
  "/:id",
  authenticate,
  getFolder
);

router.patch(
  "/:id",
  authenticate,
  updateFolder
);

router.post(
  "/:id/restore",
  authenticate,
  restoreFolder
);

router.delete(
  "/:id",
  authenticate,
  deleteFolder
);

module.exports = router;