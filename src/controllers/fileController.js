const crypto = require("crypto");
const path = require("path");

const { pool } = require("../config/database");
const { supabase, storageBucket } = require("../config/supabase");

const sanitizeFileName = (fileName) => {
  const originalName = path.basename(fileName);

  const sanitized = originalName
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_");

  return sanitized || "file";
};

const createStorageKey = (userId, folderId, fileId, fileName) => {
  const safeName = sanitizeFileName(fileName);

  const folderPart = folderId || "root";

  return `tenants/${userId}/folders/${folderPart}/files/${fileId}-${safeName}`;
};

const initUpload = async (req, res) => {
  try {
    const { name, mimeType, sizeBytes, folderId = null } = req.body;

    if (!name || !mimeType || sizeBytes === undefined) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "name, mimeType and sizeBytes are required"
        }
      });
    }

    const size = Number(sizeBytes);

    if (!Number.isFinite(size) || size <= 0) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "sizeBytes must be a positive number"
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
      name
    );

    const fileResult = await pool.query(
      `
      INSERT INTO files
      (
        id,
        name,
        mime_type,
        size_bytes,
        storage_key,
        owner_id,
        folder_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
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
        name.trim(),
        mimeType,
        size,
        storageKey,
        req.user.id,
        folderId
      ]
    );

    const file = fileResult.rows[0];

    const { data: uploadData, error: uploadError } =
      await supabase.storage
        .from(storageBucket)
        .createSignedUploadUrl(storageKey, {
          upsert: false
        });

    if (uploadError) {
      await pool.query(
        "DELETE FROM files WHERE id = $1",
        [fileId]
      );

      console.error("Supabase signed upload URL error:", uploadError);

      return res.status(500).json({
        error: {
          code: "STORAGE_ERROR",
          message: "Unable to prepare file upload"
        }
      });
    }

    return res.status(201).json({
      fileId: file.id,
      upload: {
        method: "signed",
        token: uploadData.token,
        path: storageKey
      },
      storageKey,
      file
    });
  } catch (error) {
    console.error("Initialize upload error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to initialize file upload"
      }
    });
  }
};

const completeUpload = async (req, res) => {
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

    const fileResult = await pool.query(
      `
      SELECT
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
      FROM files
      WHERE id = $1
        AND owner_id = $2
        AND is_deleted = false
      `,
      [fileId, req.user.id]
    );

    if (fileResult.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "FILE_NOT_FOUND",
          message: "File not found"
        }
      });
    }

    const file = fileResult.rows[0];

    const { data: storageObject, error: storageError } =
      await supabase.storage
        .from(storageBucket)
        .list(
          path.dirname(file.storage_key),
          {
            limit: 100,
            search: path.basename(file.storage_key)
          }
        );

    if (storageError) {
      console.error("Storage verification error:", storageError);

      return res.status(500).json({
        error: {
          code: "STORAGE_ERROR",
          message: "Unable to verify uploaded file"
        }
      });
    }

    const uploadedFile = storageObject?.find(
      (item) => item.name === path.basename(file.storage_key)
    );

    if (!uploadedFile) {
      return res.status(400).json({
        error: {
          code: "UPLOAD_INCOMPLETE",
          message: "File has not been uploaded to storage"
        }
      });
    }

    const versionResult = await pool.query(
      `
      INSERT INTO file_versions
      (
        file_id,
        version_number,
        storage_key,
        size_bytes
      )
      VALUES
      (
        $1,
        1,
        $2,
        $3
      )
      RETURNING
        id,
        file_id,
        version_number,
        storage_key,
        size_bytes,
        created_at
      `,
      [
        file.id,
        file.storage_key,
        file.size_bytes
      ]
    );

    const version = versionResult.rows[0];

    await pool.query(
      `
      UPDATE files
      SET
        version_id = $1,
        updated_at = now()
      WHERE id = $2
      `,
      [version.id, file.id]
    );

    await pool.query(
      `
      INSERT INTO activities
      (
        actor_id,
        action,
        resource_type,
        resource_id,
        context
      )
      VALUES
      (
        $1,
        'upload',
        'file',
        $2,
        $3
      )
      `,
      [
        req.user.id,
        file.id,
        JSON.stringify({
          name: file.name,
          sizeBytes: file.size_bytes
        })
      ]
    );

    return res.status(200).json({
      message: "File upload completed",
      file: {
        ...file,
        versionId: version.id
      },
      version
    });
  } catch (error) {
    console.error("Complete upload error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to complete file upload"
      }
    });
  }
};

const getFile = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        f.id,
        f.name,
        f.mime_type,
        f.size_bytes,
        f.storage_key,
        f.owner_id,
        f.folder_id,
        f.version_id,
        f.created_at,
        f.updated_at,
        u.name AS owner_name,
        u.email AS owner_email
      FROM files f
      JOIN users u
        ON u.id = f.owner_id
      WHERE f.id = $1
        AND f.owner_id = $2
        AND f.is_deleted = false
      `,
      [id, req.user.id]
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

    const { data: signedData, error: signedError } =
      await supabase.storage
        .from(storageBucket)
        .createSignedUrl(
          file.storage_key,
          3600,
          {
            download: false
          }
        );

    if (signedError) {
      console.error("Signed URL error:", signedError);

      return res.status(500).json({
        error: {
          code: "STORAGE_ERROR",
          message: "Unable to generate file URL"
        }
      });
    }

    return res.status(200).json({
      file,
      signedUrl: signedData.signedUrl
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

module.exports = {
  initUpload,
  completeUpload,
  getFile
};