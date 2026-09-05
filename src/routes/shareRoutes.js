const express = require("express");

const {
  createShare,
  listShares,
  deleteShare,
  listReceivedShares
} = require("../controllers/shareController");

const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();

router.post(
  "/",
  authenticate,
  createShare
);

router.get(
  "/received",
  authenticate,
  listReceivedShares
);

router.get(
  "/:resourceType/:resourceId",
  authenticate,
  listShares
);

router.delete(
  "/:id",
  authenticate,
  deleteShare
);

module.exports = router;