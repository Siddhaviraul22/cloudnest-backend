const express = require("express");

const {
  createFolder,
  getFolder,
  getRootChildren,
  updateFolder,
  deleteFolder,
  restoreFolder,
  permanentlyDeleteFolder,
  starFolder,
  unstarFolder,
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
router.post(
  "/:id/star",
  authenticate,
  starFolder
);

router.delete(
  "/:id/star",
  authenticate,
  unstarFolder
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
  "/:id/permanent",
  authenticate,
  permanentlyDeleteFolder
);
router.delete(
  "/:id",
  authenticate,
  deleteFolder
);

module.exports = router;