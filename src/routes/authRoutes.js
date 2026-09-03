const express = require("express");

const {
  register,
  login,
  logout,
  getMe,
  refresh
} = require("../controllers/authController");

const { setAuthCookies } = require("../utils/auth");

const passport = require("../config/passport");

const router = express.Router();

router.post("/register", register);

router.post("/login", login);

router.post("/logout", logout);

router.get("/me", require("../middleware/authMiddleware").authenticate, getMe);

router.post("/refresh", refresh);

router.get(
  "/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
    session: false
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