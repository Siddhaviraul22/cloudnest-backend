const express = require("express");

const {
  createLinkShare,
  resolveLink,
  deleteLinkShare
} = require("../controllers/linkShareController");

const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();

router.post(
  "/link-shares",
  authenticate,
  createLinkShare
);

router.get(
  "/link/:token",
  resolveLink
);

router.delete(
  "/link-shares/:id",
  authenticate,
  deleteLinkShare
);

module.exports = router;