const { pool } = require("../config/database");

const search = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const type = req.query.type || "all";
    const starred = req.query.starred === "true";

    if (!q && type === "all" && !starred) {
      return res.status(200).json({
        files: [],
        folders: []
      });
    }

    const searchPattern = `%${q}%`;

    let files = [];
    let folders = [];

    if (type === "all" || type === "file") {
      const fileResult = await pool.query(
        `
        SELECT
          f.*,
          EXISTS (
            SELECT 1
            FROM stars s
            WHERE s.user_id = $1
              AND s.resource_type = 'file'
              AND s.resource_id = f.id
          ) AS starred
        FROM files f
        WHERE f.owner_id = $1
          AND f.is_deleted = false
          AND ($2 = '' OR f.name ILIKE $3)
          AND (
            $4 = false
            OR EXISTS (
              SELECT 1
              FROM stars s2
              WHERE s2.user_id = $1
                AND s2.resource_type = 'file'
                AND s2.resource_id = f.id
            )
          )
        ORDER BY f.updated_at DESC
        LIMIT 100
        `,
        [
          req.user.id,
          q,
          searchPattern,
          starred
        ]
      );

      files = fileResult.rows;
    }

    if (type === "all" || type === "folder") {
      const folderResult = await pool.query(
        `
        SELECT
          f.*,
          EXISTS (
            SELECT 1
            FROM stars s
            WHERE s.user_id = $1
              AND s.resource_type = 'folder'
              AND s.resource_id = f.id
          ) AS starred
        FROM folders f
        WHERE f.owner_id = $1
          AND f.is_deleted = false
          AND ($2 = '' OR f.name ILIKE $3)
          AND (
            $4 = false
            OR EXISTS (
              SELECT 1
              FROM stars s2
              WHERE s2.user_id = $1
                AND s2.resource_type = 'folder'
                AND s2.resource_id = f.id
            )
          )
        ORDER BY f.updated_at DESC
        LIMIT 100
        `,
        [
          req.user.id,
          q,
          searchPattern,
          starred
        ]
      );

      folders = folderResult.rows;
    }

    return res.status(200).json({
      files,
      folders
    });
  } catch (error) {
    console.error("Search error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to search"
      }
    });
  }
};

const getActivity = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        a.*,
        u.name AS actor_name,
        u.email AS actor_email
      FROM activities a
      LEFT JOIN users u
        ON u.id = a.actor_id
      WHERE a.actor_id = $1
      ORDER BY a.created_at DESC
      LIMIT 100
      `,
      [req.user.id]
    );

    return res.status(200).json({
      activities: result.rows
    });
  } catch (error) {
    console.error("Activity error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to load activity"
      }
    });
  }
};

const getUsage = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        COALESCE(
          SUM(size_bytes)
          FILTER (WHERE is_deleted = false),
          0
        ) AS used_bytes,
        COUNT(*)
        FILTER (WHERE is_deleted = false) AS file_count
      FROM files
      WHERE owner_id = $1
      `,
      [req.user.id]
    );

    const usedBytes =
      Number(result.rows[0].used_bytes);

    const fileCount =
      Number(result.rows[0].file_count);

    const limitBytes =
      5 * 1024 * 1024 * 1024;

    return res.status(200).json({
      usedBytes,
      limitBytes,
      fileCount,
      percentage: Math.min(
        100,
        (usedBytes / limitBytes) * 100
      )
    });
  } catch (error) {
    console.error("Usage error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to load storage usage"
      }
    });
  }
};

const getSummary = async (req, res) => {
  try {
    const [
      files,
      folders,
      recent,
      starred,
      activity
    ] = await Promise.all([
      pool.query(
        `
        SELECT COUNT(*)::int AS count
        FROM files
        WHERE owner_id = $1
          AND is_deleted = false
        `,
        [req.user.id]
      ),
      pool.query(
        `
        SELECT COUNT(*)::int AS count
        FROM folders
        WHERE owner_id = $1
          AND is_deleted = false
        `,
        [req.user.id]
      ),
      pool.query(
        `
        SELECT
          id,
          name,
          mime_type,
          size_bytes,
          updated_at
        FROM files
        WHERE owner_id = $1
          AND is_deleted = false
        ORDER BY updated_at DESC
        LIMIT 10
        `,
        [req.user.id]
      ),
      pool.query(
        `
        SELECT
          f.id,
          f.name,
          f.mime_type,
          f.size_bytes,
          f.updated_at
        FROM files f
        INNER JOIN stars s
          ON s.resource_type = 'file'
         AND s.resource_id = f.id
         AND s.user_id = $1
        WHERE f.owner_id = $1
          AND f.is_deleted = false
        ORDER BY f.updated_at DESC
        LIMIT 10
        `,
        [req.user.id]
      ),
      pool.query(
        `
        SELECT
          a.*,
          u.name AS actor_name
        FROM activities a
        LEFT JOIN users u
          ON u.id = a.actor_id
        WHERE a.actor_id = $1
        ORDER BY a.created_at DESC
        LIMIT 10
        `,
        [req.user.id]
      )
    ]);

    return res.status(200).json({
      fileCount: files.rows[0].count,
      folderCount: folders.rows[0].count,
      recentFiles: recent.rows,
      starredFiles: starred.rows,
      activities: activity.rows
    });
  } catch (error) {
    console.error("Dashboard summary error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to load dashboard summary"
      }
    });
  }
};
const findUser = async (req, res) => {
  try {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();

    if (!email) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Email is required"
        }
      });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        email,
        name,
        image_url
      FROM users
      WHERE email = $1
      LIMIT 1
      `,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "USER_NOT_FOUND",
          message: "User not found"
        }
      });
    }

    return res.status(200).json({
      user: result.rows[0]
    });
  } catch (error) {
    console.error("Find user error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to find user"
      }
    });
  }
};

const getStarred = async (req, res) => {
  try {
    const [filesResult, foldersResult] =
      await Promise.all([
        pool.query(
          `
          SELECT
            f.*,
            true AS starred
          FROM files f
          INNER JOIN stars s
            ON s.resource_type = 'file'
            AND s.resource_id = f.id
            AND s.user_id = $1
          WHERE f.owner_id = $1
            AND f.is_deleted = false
          ORDER BY f.updated_at DESC
          `,
          [req.user.id]
        ),

        pool.query(
          `
          SELECT
            f.*,
            true AS starred
          FROM folders f
          INNER JOIN stars s
            ON s.resource_type = 'folder'
            AND s.resource_id = f.id
            AND s.user_id = $1
          WHERE f.owner_id = $1
            AND f.is_deleted = false
          ORDER BY f.updated_at DESC
          `,
          [req.user.id]
        )
      ]);

    return res.status(200).json({
      files: filesResult.rows,
      folders: foldersResult.rows
    });
  } catch (error) {
    console.error(
      "Starred resources error:",
      error
    );

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to load starred items"
      }
    });
  }
};
module.exports = {
  search,
  getActivity,
  getUsage,
  getSummary,
  findUser,
  getStarred
};