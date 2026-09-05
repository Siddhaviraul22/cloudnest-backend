const crypto = require("crypto");
const path = require("path");

const { pool } = require("../config/database");
const { supabase, storageBucket } = require("../config/supabase");

const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;

const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "text/plain",
  "text/csv",
  "application/json",
  "application/octet-stream"
]);

const sanitizeFileName = (name) => {
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\.\./g, "_")
    .trim()
    .slice(0, 255);
};

const createStorageKey = (userId, folderId, fileId, fileName) => {
  const safeName = sanitizeFileName(fileName);

  return `tenants/${userId}/folders/${
    folderId || "root"
  }/files/${fileId}-${safeName}`;
};

const recordActivity = async (
  client,
  actorId,
  action,
  resourceType,
  resourceId,
  context = {}
) => {
  await client.query(
    `
    INSERT INTO activities
      (actor_id, action, resource_type, resource_id, context)
    VALUES ($1, $2, $3, $4, $5)
    `,
    [
      actorId,
      action,
      resourceType,
      resourceId,
      JSON.stringify(context)
    ]
  );
};

const initUpload = async (req, res) => {
  try {
    const {
      name,
      mimeType,
      sizeBytes,
      folderId = null
    } = req.body;

    if (!name || !mimeType || sizeBytes === undefined) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Name, mimeType and sizeBytes are required"
        }
      });
    }

    const numericSize = Number(sizeBytes);

    if (!Number.isFinite(numericSize) || numericSize < 0) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid file size"
        }
      });
    }

    if (numericSize > MAX_FILE_SIZE) {
      return res.status(413).json({
        error: {
          code: "FILE_TOO_LARGE",
          message: "Maximum file size is 5 GB"
        }
      });
    }

    if (!allowedMimeTypes.has(mimeType)) {
      return res.status(400).json({
        error: {
          code: "INVALID_FILE_TYPE",
          message: "This file type is not supported"
        }
      });
    }

    const safeName = sanitizeFileName(name);

    if (!safeName) {
      return res.status(400).json({
        error: {
          code: "INVALID_FILE_NAME",
          message: "Invalid file name"
        }
      });
    }

    if (folderId) {
      const folderResult = await pool.query(
        `
        SELECT id
        FROM folders
        WHERE id = $1
          AND owner_id = $2
          AND is_deleted = false
        `,
        [folderId, req.user.id]
      );

      if (folderResult.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: "FOLDER_NOT_FOUND",
            message: "Folder not found"
          }
        });
      }
    }

    const fileId = crypto.randomUUID();

    const storageKey = createStorageKey(
      req.user.id,
      folderId,
      fileId,
      safeName
    );

    const fileResult = await pool.query(
      `
      INSERT INTO files
        (id, name, mime_type, size_bytes, storage_key, owner_id, folder_id)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7)
      RETURNING
        id,
        name,
        mime_type,
        size_bytes,
        storage_key,
        owner_id,
        folder_id,
        is_deleted,
        created_at,
        updated_at
      `,
      [
        fileId,
        safeName,
        mimeType,
        numericSize,
        storageKey,
        req.user.id,
        folderId
      ]
    );

    const { data, error } =
      await supabase.storage
        .from(storageBucket)
        .createSignedUploadUrl(storageKey);

    if (error) {
      await pool.query(
        "DELETE FROM files WHERE id = $1",
        [fileId]
      );

      console.error("Create signed upload URL error:", error);

      return res.status(500).json({
        error: {
          code: "STORAGE_ERROR",
          message: "Unable to create upload URL"
        }
      });
    }

    return res.status(201).json({
      fileId,
      upload: {
        method: "signed",
        token: data.token,
        path: storageKey
      },
      storageKey,
      file: fileResult.rows[0]
    });
  } catch (error) {
    console.error("Init upload error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to initialize upload"
      }
    });
  }
};

const completeUpload = async (req, res) => {
  const client = await pool.connect();

  try {
    const { fileId } = req.body;

    if (!fileId) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "fileId is required"
        }
      });
    }

    await client.query("BEGIN");

    const fileResult = await client.query(
      `
      SELECT *
      FROM files
      WHERE id = $1
        AND owner_id = $2
      FOR UPDATE
      `,
      [fileId, req.user.id]
    );

    if (fileResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: {
          code: "FILE_NOT_FOUND",
          message: "File not found"
        }
      });
    }

    const file = fileResult.rows[0];

    const folderPath = file.storage_key
      .split("/")
      .slice(0, -1)
      .join("/");

    const { data: objects, error: listError } =
      await supabase.storage
        .from(storageBucket)
        .list(folderPath, {
          limit: 100,
          search: file.storage_key.split("/").pop()
        });

    if (listError) {
      await client.query("ROLLBACK");

      return res.status(500).json({
        error: {
          code: "STORAGE_ERROR",
          message: "Unable to verify uploaded file"
        }
      });
    }

    if (!objects || objects.length === 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: {
          code: "UPLOAD_NOT_FOUND",
          message: "Uploaded file was not found in storage"
        }
      });
    }

    const versionResult = await client.query(
      `
      SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
      FROM file_versions
      WHERE file_id = $1
      `,
      [fileId]
    );

    const versionNumber =
      Number(versionResult.rows[0].next_version);

    const versionInsert = await client.query(
      `
      INSERT INTO file_versions
        (file_id, version_number, storage_key, size_bytes)
      VALUES
        ($1, $2, $3, $4)
      RETURNING *
      `,
      [
        fileId,
        versionNumber,
        file.storage_key,
        file.size_bytes
      ]
    );

    const version = versionInsert.rows[0];

    await client.query(
      `
      UPDATE files
      SET
        version_id = $1,
        is_deleted = false,
        updated_at = now()
      WHERE id = $2
      `,
      [version.id, fileId]
    );

    await recordActivity(
      client,
      req.user.id,
      "upload",
      "file",
      fileId,
      {
        name: file.name,
        sizeBytes: file.size_bytes
      }
    );

    await client.query("COMMIT");

    return res.status(200).json({
      message: "Upload completed successfully",
      file: {
        id: file.id,
        name: file.name,
        mimeType: file.mime_type,
        sizeBytes: file.size_bytes,
        folderId: file.folder_id
      },
      version
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Complete upload error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to complete upload"
      }
    });
  } finally {
    client.release();
  }
};

const listFiles = async (req, res) => {
  try {
    const folderId = req.query.folderId || null;

    const result = await pool.query(
      `
      SELECT
        f.id,
        f.name,
        f.mime_type,
        f.size_bytes,
        f.folder_id,
        f.version_id,
        f.is_deleted,
        f.created_at,
        f.updated_at,
        EXISTS (
          SELECT 1
          FROM stars s
          WHERE s.user_id = $1
            AND s.resource_type = 'file'
            AND s.resource_id = f.id
        ) AS starred
      FROM files f
      WHERE f.owner_id = $1
        AND f.folder_id IS NOT DISTINCT FROM $2
        AND f.is_deleted = false
      ORDER BY f.updated_at DESC
      `,
      [req.user.id, folderId]
    );

    return res.status(200).json({
      files: result.rows
    });
  } catch (error) {
    console.error("List files error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to list files"
      }
    });
  }
};

const getFile = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM files
      WHERE id = $1
        AND owner_id = $2
        AND is_deleted = false
      `,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "FILE_NOT_FOUND",
          message: "File not found"
        }
      });
    }

    const file = result.rows[0];

    const { data, error } =
      await supabase.storage
        .from(storageBucket)
        .createSignedUrl(
          file.storage_key,
          3600,
          {
            download: false
          }
        );

    if (error) {
      return res.status(500).json({
        error: {
          code: "STORAGE_ERROR",
          message: "Unable to create signed URL"
        }
      });
    }

    return res.status(200).json({
      file,
      signedUrl: data.signedUrl
    });
  } catch (error) {
    console.error("Get file error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to get file"
      }
    });
  }
};

const downloadFile = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM files
      WHERE id = $1
        AND owner_id = $2
        AND is_deleted = false
      `,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "FILE_NOT_FOUND",
          message: "File not found"
        }
      });
    }

    const file = result.rows[0];

    const { data, error } =
      await supabase.storage
        .from(storageBucket)
        .createSignedUrl(
          file.storage_key,
          3600,
          {
            download: file.name
          }
        );

    if (error) {
      return res.status(500).json({
        error: {
          code: "STORAGE_ERROR",
          message: "Unable to create download URL"
        }
      });
    }

    await recordActivity(
      pool,
      req.user.id,
      "download",
      "file",
      file.id,
      {
        name: file.name
      }
    );

    return res.status(200).json({
      downloadUrl: data.signedUrl
    });
  } catch (error) {
    console.error("Download file error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to download file"
      }
    });
  }
};

const updateFile = async (req, res) => {
  const client = await pool.connect();

  try {
    const { name, folderId } = req.body;

    if (name === undefined && folderId === undefined) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Nothing to update"
        }
      });
    }

    await client.query("BEGIN");

    const existing = await client.query(
      `
      SELECT *
      FROM files
      WHERE id = $1
        AND owner_id = $2
        AND is_deleted = false
      FOR UPDATE
      `,
      [req.params.id, req.user.id]
    );

    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: {
          code: "FILE_NOT_FOUND",
          message: "File not found"
        }
      });
    }

    const file = existing.rows[0];

    if (folderId !== undefined && folderId !== null) {
      const folder = await client.query(
        `
        SELECT id
        FROM folders
        WHERE id = $1
          AND owner_id = $2
          AND is_deleted = false
        `,
        [folderId, req.user.id]
      );

      if (folder.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: {
            code: "FOLDER_NOT_FOUND",
            message: "Destination folder not found"
          }
        });
      }
    }

    const safeName =
      name !== undefined
        ? sanitizeFileName(name)
        : file.name;

    if (!safeName) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: {
          code: "INVALID_FILE_NAME",
          message: "Invalid file name"
        }
      });
    }

    const newFolderId =
      folderId !== undefined
        ? folderId
        : file.folder_id;

    const updated = await client.query(
      `
      UPDATE files
      SET
        name = $1,
        folder_id = $2,
        updated_at = now()
      WHERE id = $3
      RETURNING *
      `,
      [
        safeName,
        newFolderId,
        file.id
      ]
    );

    const action =
      name !== undefined && folderId !== undefined
        ? "rename"
        : name !== undefined
          ? "rename"
          : "move";

    await recordActivity(
      client,
      req.user.id,
      action,
      "file",
      file.id,
      {
        oldName: file.name,
        newName: safeName,
        oldFolderId: file.folder_id,
        newFolderId
      }
    );

    await client.query("COMMIT");

    return res.status(200).json({
      file: updated.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Update file error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to update file"
      }
    });
  } finally {
    client.release();
  }
};

const deleteFile = async (req, res) => {
  try {
    const result = await pool.query(
      `
      UPDATE files
      SET
        is_deleted = true,
        updated_at = now()
      WHERE id = $1
        AND owner_id = $2
        AND is_deleted = false
      RETURNING *
      `,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "FILE_NOT_FOUND",
          message: "File not found"
        }
      });
    }

    const file = result.rows[0];

    await recordActivity(
      pool,
      req.user.id,
      "delete",
      "file",
      file.id,
      {
        name: file.name
      }
    );

    return res.status(200).json({
      message: "File moved to trash",
      file
    });
  } catch (error) {
    console.error("Delete file error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to delete file"
      }
    });
  }
};

const restoreFile = async (req, res) => {
  try {
    const result = await pool.query(
      `
      UPDATE files
      SET
        is_deleted = false,
        updated_at = now()
      WHERE id = $1
        AND owner_id = $2
        AND is_deleted = true
      RETURNING *
      `,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "FILE_NOT_FOUND",
          message: "Deleted file not found"
        }
      });
    }

    const file = result.rows[0];

    await recordActivity(
      pool,
      req.user.id,
      "restore",
      "file",
      file.id,
      {
        name: file.name
      }
    );

    return res.status(200).json({
      message: "File restored",
      file
    });
  } catch (error) {
    console.error("Restore file error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to restore file"
      }
    });
  }
};

const permanentDeleteFile = async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
      SELECT *
      FROM files
      WHERE id = $1
        AND owner_id = $2
        AND is_deleted = true
      FOR UPDATE
      `,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: {
          code: "FILE_NOT_FOUND",
          message: "Deleted file not found"
        }
      });
    }

    const file = result.rows[0];

    const { error: storageError } =
      await supabase.storage
        .from(storageBucket)
        .remove([file.storage_key]);

    if (storageError) {
      console.error(
        "Storage permanent delete error:",
        storageError
      );
    }

    await client.query(
      `
      DELETE FROM files
      WHERE id = $1
        AND owner_id = $2
      `,
      [file.id, req.user.id]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      message: "File permanently deleted"
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Permanent delete file error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to permanently delete file"
      }
    });
  } finally {
    client.release();
  }
};

const listTrash = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        name,
        mime_type,
        size_bytes,
        folder_id,
        created_at,
        updated_at
      FROM files
      WHERE owner_id = $1
        AND is_deleted = true
      ORDER BY updated_at DESC
      `,
      [req.user.id]
    );

    return res.status(200).json({
      files: result.rows
    });
  } catch (error) {
    console.error("List trash error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to load trash"
      }
    });
  }
};

const starFile = async (req, res) => {
  try {
    const file = await pool.query(
      `
      SELECT id
      FROM files
      WHERE id = $1
        AND owner_id = $2
        AND is_deleted = false
      `,
      [req.params.id, req.user.id]
    );

    if (file.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "FILE_NOT_FOUND",
          message: "File not found"
        }
      });
    }

    await pool.query(
      `
      INSERT INTO stars
        (user_id, resource_type, resource_id)
      VALUES
        ($1, 'file', $2)
      ON CONFLICT DO NOTHING
      `,
      [req.user.id, req.params.id]
    );

    return res.status(200).json({
      starred: true
    });
  } catch (error) {
    console.error("Star file error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to star file"
      }
    });
  }
};

const unstarFile = async (req, res) => {
  try {
    await pool.query(
      `
      DELETE FROM stars
      WHERE user_id = $1
        AND resource_type = 'file'
        AND resource_id = $2
      `,
      [req.user.id, req.params.id]
    );

    return res.status(200).json({
      starred: false
    });
  } catch (error) {
    console.error("Unstar file error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to remove star"
      }
    });
  }
};

const listStarredFiles = async (req, res) => {
  try {
    const result = await pool.query(
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
    );

    return res.status(200).json({
      files: result.rows
    });
  } catch (error) {
    console.error("Starred files error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to load starred files"
      }
    });
  }
};

const listRecentFiles = async (req, res) => {
  try {
    const result = await pool.query(
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
      ORDER BY f.updated_at DESC
      LIMIT 50
      `,
      [req.user.id]
    );

    return res.status(200).json({
      files: result.rows
    });
  } catch (error) {
    console.error("Recent files error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to load recent files"
      }
    });
  }
};

const listVersions = async (req, res) => {
  try {
    const ownership = await pool.query(
      `
      SELECT id
      FROM files
      WHERE id = $1
        AND owner_id = $2
      `,
      [req.params.id, req.user.id]
    );

    if (ownership.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "FILE_NOT_FOUND",
          message: "File not found"
        }
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM file_versions
      WHERE file_id = $1
      ORDER BY version_number DESC
      `,
      [req.params.id]
    );

    return res.status(200).json({
      versions: result.rows
    });
  } catch (error) {
    console.error("List versions error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to load file versions"
      }
    });
  }
};

module.exports = {
  initUpload,
  completeUpload,
  listFiles,
  getFile,
  downloadFile,
  updateFile,
  deleteFile,
  restoreFile,
  permanentDeleteFile,
  listTrash,
  starFile,
  unstarFile,
  listStarredFiles,
  listRecentFiles,
  listVersions
};