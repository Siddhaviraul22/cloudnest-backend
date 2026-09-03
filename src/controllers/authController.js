const bcrypt = require("bcryptjs");

const { pool } = require("../config/database");
const {
  setAuthCookies,
  clearAuthCookies,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken
} = require("../utils/auth");

const register = async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Name, email and password are required"
        }
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Password must contain at least 8 characters"
        }
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existingUser = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        error: {
          code: "EMAIL_EXISTS",
          message: "An account with this email already exists"
        }
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `
      INSERT INTO users (email, name)
      VALUES ($1, $2)
      RETURNING id, email, name, image_url, created_at
      `,
      [normalizedEmail, name.trim()]
    );

    const user = result.rows[0];

    await pool.query(
      `
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password_hash text
      `
    );

    await pool.query(
      `
      UPDATE users
      SET password_hash = $1
      WHERE id = $2
      `,
      [passwordHash, user.id]
    );

    setAuthCookies(res, user);

    return res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        imageUrl: user.image_url
      }
    });
  } catch (error) {
    console.error("Register error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to create account"
      }
    });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Email and password are required"
        }
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const result = await pool.query(
      `
      SELECT id, email, name, image_url, password_hash
      FROM users
      WHERE email = $1
      `,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "Invalid email or password"
        }
      });
    }

    const user = result.rows[0];

    if (!user.password_hash) {
      return res.status(401).json({
        error: {
          code: "PASSWORD_LOGIN_UNAVAILABLE",
          message: "This account does not have a password login"
        }
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "Invalid email or password"
        }
      });
    }

    setAuthCookies(res, user);

    return res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        imageUrl: user.image_url
      }
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to log in"
      }
    });
  }
};

const logout = async (req, res) => {
  clearAuthCookies(res);

  return res.status(200).json({
    message: "Logged out successfully"
  });
};

const getMe = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, email, name, image_url, created_at
      FROM users
      WHERE id = $1
      `,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      clearAuthCookies(res);

      return res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "User no longer exists"
        }
      });
    }

    const user = result.rows[0];

    return res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        imageUrl: user.image_url,
        createdAt: user.created_at
      }
    });
  } catch (error) {
    console.error("Get current user error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to get current user"
      }
    });
  }
};

const refresh = async (req, res) => {
  try {
    const refreshToken = req.cookies.refresh_token;

    if (!refreshToken) {
      return res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Refresh token required"
        }
      });
    }

    const decoded = verifyRefreshToken(refreshToken);

    const result = await pool.query(
      `
      SELECT id, email, name, image_url
      FROM users
      WHERE id = $1
      `,
      [decoded.id]
    );

    if (result.rows.length === 0) {
      clearAuthCookies(res);

      return res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "User no longer exists"
        }
      });
    }

    const user = result.rows[0];

    const accessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    const isProduction = process.env.NODE_ENV === "production";

    res.cookie("access_token", accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 15 * 60 * 1000
    });

    res.cookie("refresh_token", newRefreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    return res.status(200).json({
      message: "Token refreshed"
    });
  } catch (error) {
    clearAuthCookies(res);

    return res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid or expired refresh token"
      }
    });
  }
};

module.exports = {
  register,
  login,
  logout,
  getMe,
  refresh
};