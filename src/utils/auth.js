const jwt = require("jsonwebtoken");

const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY = "7d";

const generateAccessToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name
    },
    process.env.JWT_SECRET,
    {
      expiresIn: ACCESS_TOKEN_EXPIRY
    }
  );
};

const generateRefreshToken = (user) => {
  return jwt.sign(
    {
      id: user.id
    },
    process.env.REFRESH_SECRET,
    {
      expiresIn: REFRESH_TOKEN_EXPIRY
    }
  );
};

const setAuthCookies = (res, user) => {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);

  const isProduction = process.env.NODE_ENV === "production";

  res.cookie("access_token", accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: 15 * 60 * 1000
  });

  res.cookie("refresh_token", refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
};

const clearAuthCookies = (res) => {
  const isProduction = process.env.NODE_ENV === "production";

  const options = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax"
  };

  res.clearCookie("access_token", options);
  res.clearCookie("refresh_token", options);
};

const verifyAccessToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET);
};

const verifyRefreshToken = (token) => {
  return jwt.verify(token, process.env.REFRESH_SECRET);
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  setAuthCookies,
  clearAuthCookies,
  verifyAccessToken,
  verifyRefreshToken
};