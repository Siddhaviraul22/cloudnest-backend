const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const { pool } = require("../config/database");
const {
  supabase,
  storageBucket
} = require("../config/supabase");

const createLinkShare = async (req, res) => {
  try {
    const {
      resourceType,
      resourceId,
      expiresAt = null,
      password = null
    } = req.body;

    if (
      !["file", "folder"].includes(resourceType) ||
      !resourceId
    ) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid resource information"
        }
      });
    }

    const table =
      resourceType === "file"
        ? "files"
        : "folders";

    const resource = await pool.query(
      `
      SELECT id
      FROM ${table}
      WHERE id = $1
        AND owner_id = $2
        AND is_deleted = false
      `,
      [
        resourceId,
        req.user.id
      ]
    );

    if (resource.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "Resource not found"
        }
      });
    }

    const token = crypto
      .randomBytes(32)
      .toString("hex");

    const passwordHash = password
      ? await bcrypt.hash(password, 12)
      : null;

    const result = await pool.query(
      `
      INSERT INTO link_shares
        (
          resource_type,
          resource_id,
          token,
          role,
          password_hash,
          expires_at,
          created_by
        )
      VALUES
        ($1, $2, $3, 'viewer', $4, $5, $6)
      RETURNING
        id,
        resource_type,
        resource_id,
        token,
        role,
        expires_at,
        created_at
      `,
      [
        resourceType,
        resourceId,
        token,
        passwordHash,
        expiresAt,
        req.user.id
      ]
    );

    return res.status(201).json({
      link: result.rows[0],
      url: `/share/${token}`
    });
  } catch (error) {
    console.error("Create link share error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to create share link"
      }
    });
  }
};

const resolveLink = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM link_shares
      WHERE token = $1
      `,
      [req.params.token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "LINK_NOT_FOUND",
          message: "Share link not found"
        }
      });
    }

    const link = result.rows[0];

    if (
      link.expires_at &&
      new Date(link.expires_at) < new Date()
    ) {
      return res.status(410).json({
        error: {
          code: "LINK_EXPIRED",
          message: "This share link has expired"
        }
      });
    }

    const password =
  req.headers["x-share-password"] ||
  req.body?.password ||
  req.query?.password ||
  "";

if (link.password_hash) {
  if (!password) {
    return res.status(401).json({
      error: {
        code: "PASSWORD_REQUIRED",
        message: "Password required"
      }
    });
  }

  const valid =
    await bcrypt.compare(
      password,
      link.password_hash
    );

  if (!valid) {
    return res.status(401).json({
      error: {
        code: "INVALID_PASSWORD",
        message: "Invalid password"
      }
    });
  }
}

    let resource;

    if (link.resource_type === "file") {
      const fileResult = await pool.query(
        `
        SELECT
          id,
          name,
          mime_type,
          size_bytes,
          storage_key,
          created_at
        FROM files
        WHERE id = $1
          AND is_deleted = false
        `,
        [link.resource_id]
      );

      if (fileResult.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "Shared file no longer exists"
          }
        });
      }

      const file = fileResult.rows[0];

      const signed =
        await supabase.storage
          .from(storageBucket)
          .createSignedUrl(
            file.storage_key,
            3600
          );

      if (signed.error) {
        return res.status(500).json({
          error: {
            code: "STORAGE_ERROR",
            message: "Unable to create preview URL"
          }
        });
      }

      resource = {
        ...file,
        signedUrl: signed.data.signedUrl
      };
    } else {
      const folderResult = await pool.query(
        `
        SELECT
          id,
          name,
          created_at,
          updated_at
        FROM folders
        WHERE id = $1
          AND is_deleted = false
        `,
        [link.resource_id]
      );

      if (folderResult.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "Shared folder no longer exists"
          }
        });
      }

      resource = folderResult.rows[0];
    }

    return res.status(200).json({
      resourceType: link.resource_type,
      role: link.role,
      resource
    });
  } catch (error) {
    console.error("Resolve link error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to resolve share link"
      }
    });
  }
};

const deleteLinkShare = async (req, res) => {
  try {
    const result = await pool.query(
      `
      DELETE FROM link_shares
      WHERE id = $1
        AND created_by = $2
      RETURNING id
      `,
      [
        req.params.id,
        req.user.id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "LINK_NOT_FOUND",
          message: "Share link not found"
        }
      });
    }

    return res.status(200).json({
      message: "Share link deleted"
    });
  } catch (error) {
    console.error("Delete link share error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to delete share link"
      }
    });
  }
};

module.exports = {
  createLinkShare,
  resolveLink,
  deleteLinkShare
};