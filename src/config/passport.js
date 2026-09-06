const passport = require("passport");
const GoogleStrategy =
  require("passport-google-oauth20").Strategy;

const { pool } = require("./database");

passport.use(
  new GoogleStrategy(
    {
      clientID:
        process.env.GOOGLE_CLIENT_ID,

      clientSecret:
        process.env.GOOGLE_CLIENT_SECRET,

      callbackURL:
        process.env.GOOGLE_CALLBACK_URL,

      userProfileURL:
  "https://openidconnect.googleapis.com/v1/userinfo"
    },

    async (accessToken, refreshToken, profile, done) => {
  console.log("GOOGLE ACCESS TOKEN RECEIVED:", Boolean(accessToken));
  console.log(
    "GOOGLE ACCESS TOKEN LENGTH:",
    accessToken ? accessToken.length : 0
  );
      try {
        const email =
          profile.emails?.[0]?.value;

        if (!email) {
          return done(
            new Error(
              "Google account email not available"
            )
          );
        }

        const name =
          profile.displayName ||
          profile.name?.givenName ||
          "CloudNest User";

        const imageUrl =
          profile.photos?.[0]?.value ||
          null;

        const existingUser =
          await pool.query(
            `
            SELECT
              id,
              email,
              name,
              image_url
            FROM users
            WHERE email = $1
            `,
            [email]
          );

        if (existingUser.rows.length > 0) {
          return done(
            null,
            existingUser.rows[0]
          );
        }

        const newUser =
          await pool.query(
            `
            INSERT INTO users
              (email, name, image_url)
            VALUES
              ($1, $2, $3)
            RETURNING
              id,
              email,
              name,
              image_url
            `,
            [
              email,
              name,
              imageUrl
            ]
          );

        return done(
          null,
          newUser.rows[0]
        );
      } catch (error) {
        return done(error);
      }
    }
  )
);

module.exports = passport;