const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});

const testDatabaseConnection = async () => {
  try {
    const client = await pool.connect();

    const result = await client.query("SELECT NOW() AS current_time");

    console.log("PostgreSQL connected successfully.");
    console.log("Database time:", result.rows[0].current_time);

    client.release();
  } catch (error) {
    console.error("PostgreSQL connection failed.");
    console.error(error.message);
    process.exit(1);
  }
};

module.exports = {
  pool,
  testDatabaseConnection
};