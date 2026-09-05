const { pool } = require("../config/database");

const recordActivity = async (
  actorId,
  resourceType,
  resourceId,
  context
) => {
  await pool.query(
    `
    INSERT INTO activities
      (actor_id, action, resource_type, resource_id, context)
    VALUES
      ($1, 'share', $2, $3, $4)
    `,
    [
      actorId,
      resourceType,
      resourceId,
      JSON.stringify(context || {})
    ]
  );
};

const resourceExistsForOwner = async (
  resourceType,
  resourceId,
  ownerId
) => {
  const table =
    resourceType === "file"
      ? "files"
      : "folders";

  const result = await pool.query(
    `
    SELECT id
    FROM ${table}
    WHERE id = $1
      AND owner_id = $2
      AND is_deleted = false
    `,
    [resourceId, ownerId]
  );

  return result.rows.length > 0;
};

const createShare = async (req, res) => {
  try {
    const {
      resourceType,
      resourceId,
      granteeUserId,
      role
    } = req.body;

    if (
      !["file", "folder"].includes(resourceType) ||
      !resourceId ||
      !granteeUserId ||
      !["viewer", "editor"].includes(role)
    ) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid share information"
        }
      });
    }

    const exists =
      await resourceExistsForOwner(
        resourceType,
        resourceId,
        req.user.id
      );

    if (!exists) {
      return res.status(404).json({
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "Resource not found"
        }
      });
    }

    const grantee = await pool.query(
      `
      SELECT id, email, name, image_url
      FROM users
      WHERE id = $1
      `,
      [granteeUserId]
    );

    if (grantee.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "USER_NOT_FOUND",
          message: "User not found"
        }
      });
    }

    if (granteeUserId === req.user.id) {
      return res.status(400).json({
        error: {
          code: "INVALID_GRANTEE",
          message: "You cannot share a resource with yourself"
        }
      });
    }

    const result = await pool.query(
      `
      INSERT INTO shares
        (
          resource_type,
          resource_id,
          grantee_user_id,
          role,
          created_by
        )
      VALUES
        ($1, $2, $3, $4, $5)
      ON CONFLICT
        (resource_type, resource_id, grantee_user_id)
      DO UPDATE SET
        role = EXCLUDED.role
      RETURNING *
      `,
      [
        resourceType,
        resourceId,
        granteeUserId,
        role,
        req.user.id
      ]
    );

    await recordActivity(
      req.user.id,
      resourceType,
      resourceId,
      {
        granteeUserId,
        role
      }
    );

    return res.status(201).json({
      share: result.rows[0]
    });
  } catch (error) {
    console.error("Create share error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to create share"
      }
    });
  }
};

const listShares = async (req, res) => {
  try {
    const {
      resourceType,
      resourceId
    } = req.params;

    const result = await pool.query(
      `
      SELECT
        s.id,
        s.resource_type,
        s.resource_id,
        s.role,
        s.created_at,
        u.id AS user_id,
        u.email,
        u.name,
        u.image_url
      FROM shares s
      INNER JOIN users u
        ON u.id = s.grantee_user_id
      WHERE s.resource_type = $1
        AND s.resource_id = $2
      ORDER BY s.created_at DESC
      `,
      [
        resourceType,
        resourceId
      ]
    );

    return res.status(200).json({
      shares: result.rows
    });
  } catch (error) {
    console.error("List shares error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to load shares"
      }
    });
  }
};

const deleteShare = async (req, res) => {
  try {
    const result = await pool.query(
      `
      DELETE FROM shares
      WHERE id = $1
        AND created_by = $2
      RETURNING *
      `,
      [
        req.params.id,
        req.user.id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "SHARE_NOT_FOUND",
          message: "Share not found"
        }
      });
    }

    return res.status(200).json({
      message: "Share removed"
    });
  } catch (error) {
    console.error("Delete share error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to remove share"
      }
    });
  }
};

const listReceivedShares = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        s.id,
        s.resource_type,
        s.resource_id,
        s.role,
        s.created_at,
        u.email AS owner_email,
        u.name AS owner_name,
        CASE
          WHEN s.resource_type = 'file'
          THEN f.name
          ELSE fo.name
        END AS resource_name
      FROM shares s
      INNER JOIN users u
        ON u.id = s.created_by
      LEFT JOIN files f
        ON s.resource_type = 'file'
       AND f.id = s.resource_id
      LEFT JOIN folders fo
        ON s.resource_type = 'folder'
       AND fo.id = s.resource_id
      WHERE s.grantee_user_id = $1
      ORDER BY s.created_at DESC
      `,
      [req.user.id]
    );

    return res.status(200).json({
      shares: result.rows
    });
  } catch (error) {
    console.error("Received shares error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to load shared resources"
      }
    });
  }
};

module.exports = {
  createShare,
  listShares,
  deleteShare,
  listReceivedShares
};