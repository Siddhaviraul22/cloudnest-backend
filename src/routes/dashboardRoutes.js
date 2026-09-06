const express = require("express");

const {
  search,
  getActivity,
  getUsage,
  getSummary,
  findUser,
  getStarred
} = require("../controllers/dashboardController");

const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();

router.get(
  "/search",
  authenticate,
  search
);

router.get(
  "/activity",
  authenticate,
  getActivity
);

router.get(
  "/usage",
  authenticate,
  getUsage
);

router.get(
  "/summary",
  authenticate,
  getSummary
);

router.get(
  "/users",
  authenticate,
  findUser
);
router.get(
  "/starred",
  authenticate,
  getStarred
);

module.exports = router;