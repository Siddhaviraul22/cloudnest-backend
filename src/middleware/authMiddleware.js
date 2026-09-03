const { verifyAccessToken } = require("../utils/auth");

const authenticate = (req, res, next) => {
  try {
    const token = req.cookies.access_token;

    if (!token) {
      return res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required"
        }
      });
    }

    const decoded = verifyAccessToken(token);

    req.user = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name
    };

    next();
  } catch (error) {
    return res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid or expired authentication token"
      }
    });
  }
};

module.exports = {
  authenticate
};