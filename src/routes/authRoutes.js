const express = require("express");
const passport = require("passport");

const {
  register,
  login,
  logout,
  getMe,
  refresh
} = require("../controllers/authController");

const { setAuthCookies } = require("../utils/auth");
const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();

// Email/password authentication
router.post("/register", register);
router.post("/login", login);
router.post("/logout", logout);
router.get("/me", authenticate, getMe);
router.post("/refresh", refresh);

// Google OAuth
router.get(
  "/google",
  passport.authenticate("google", {
    scope: ["profile", "email"]
  })
);

router.get(
  "/google/callback",
  passport.authenticate("google", {
    session: false,
    failureRedirect: "http://localhost:3000/login"
  }),
  (req, res) => {
    setAuthCookies(res, req.user);

    res.redirect("http://localhost:3000/dashboard");
  }
);

module.exports = router;