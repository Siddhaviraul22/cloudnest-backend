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
    scope: ["openid", "profile", "email"],
    session: false
  })
);

router.get(
  "/google/callback",
  passport.authenticate("google", {
    session: false,
    failureRedirect:
      "https://cloudnest-frontend-ten.vercel.app/login"
  }),
  (req, res) => {
    setAuthCookies(res, req.user);

    res.redirect(
      "https://cloudnest-frontend-ten.vercel.app/dashboard"
    );
  }
);

module.exports = router;