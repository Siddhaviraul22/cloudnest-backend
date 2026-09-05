const { pool } = require("../config/database");

const sanitizeFolderName = (name) => {
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\.\./g, "_")
    .trim()
    .slice(0, 255);
};

const recordActivity = async (
  actorId,
  action,
  resourceId,
  context = {}
) => {
  await pool.query(
    `
    INSERT INTO activities
      (actor_id, action, resource_type, resource_id, context)
    VALUES
      ($1, $2, 'folder', $3, $4)
    `,
    [
      actorId,
      action,
      resourceId,
      JSON.stringify(context)
    ]
  );
};

const createFolder = async (req, res) => {
  try {
    const {
      name,
      parentId = null
    } = req.body;

    const safeName = sanitizeFolderName(name || "");

    if (!safeName) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Folder name is required"
        }
      });
    }

    if (parentId) {
      const parent = await pool.query(
        `
        SELECT id
        FROM folders
        WHERE id = $1
          AND owner_id = $2
          AND is_deleted = false
        `,
        [parentId, req.user.id]
      );

      if (parent.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: "PARENT_FOLDER_NOT_FOUND",
            message: "Parent folder not found"
          }
        });
      }
    }

    const result = await pool.query(
      `
      INSERT INTO folders
        (name, owner_id, parent_id)
      VALUES
        ($1, $2, $3)
      RETURNING *
      `,
      [
        safeName,
        req.user.id,
        parentId
      ]
    );

    await recordActivity(
      req.user.id,
      "upload",
      result.rows[0].id,
      {
        type: "folder_create",
        name: safeName
      }
    );

    return res.status(201).json({
      folder: result.rows[0]
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: {
          code: "FOLDER_EXISTS",
          message: "A folder with this name already exists"
        }
      });
    }

    console.error("Create folder error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to create folder"
      }
    });
  }
};

const getFolder = async (req, res) => {
  try {
    const folderId = req.params.id;

    const folderResult = await pool.query(
      `
      SELECT *
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

    const folder = folderResult.rows[0];

    const folders = await pool.query(
      `
      SELECT
        id,
        name,
        owner_id,
        parent_id,
        created_at,
        updated_at
      FROM folders
      WHERE owner_id = $1
        AND parent_id = $2
        AND is_deleted = false
      ORDER BY name ASC
      `,
      [req.user.id, folderId]
    );

    const files = await pool.query(
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
        AND f.folder_id = $2
        AND f.is_deleted = false
      ORDER BY f.name ASC
      `,
      [req.user.id, folderId]
    );

    const path = [];

    let currentId = folderId;

    while (currentId) {
      const current = await pool.query(
        `
        SELECT id, name, parent_id
        FROM folders
        WHERE id = $1
          AND owner_id = $2
          AND is_deleted = false
        `,
        [currentId, req.user.id]
      );

      if (current.rows.length === 0) {
        break;
      }

      path.unshift(current.rows[0]);

      currentId = current.rows[0].parent_id;
    }

    return res.status(200).json({
      folder,
      children: {
        folders: folders.rows,
        files: files.rows
      },
      path
    });
  } catch (error) {
    console.error("Get folder error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to load folder"
      }
    });
  }
};

const getRootChildren = async (req, res) => {
  try {
    const folders = await pool.query(
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
        AND f.parent_id IS NULL
        AND f.is_deleted = false
      ORDER BY f.name ASC
      `,
      [req.user.id]
    );

    const files = await pool.query(
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
        AND f.folder_id IS NULL
        AND f.is_deleted = false
      ORDER BY f.name ASC
      `,
      [req.user.id]
    );

    return res.status(200).json({
      folders: folders.rows,
      files: files.rows,
      path: []
    });
  } catch (error) {
    console.error("Root children error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to load drive"
      }
    });
  }
};

const updateFolder = async (req, res) => {
  try {
    const {
      name,
      parentId
    } = req.body;

    const existing = await pool.query(
      `
      SELECT *
      FROM folders
      WHERE id = $1
        AND owner_id = $2
        AND is_deleted = false
      `,
      [req.params.id, req.user.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "FOLDER_NOT_FOUND",
          message: "Folder not found"
        }
      });
    }

    const folder = existing.rows[0];

    const safeName =
      name !== undefined
        ? sanitizeFolderName(name)
        : folder.name;

    const newParentId =
      parentId !== undefined
        ? parentId
        : folder.parent_id;

    if (!safeName) {
      return res.status(400).json({
        error: {
          code: "INVALID_FOLDER_NAME",
          message: "Invalid folder name"
        }
      });
    }

    if (newParentId === folder.id) {
      return res.status(400).json({
        error: {
          code: "INVALID_PARENT",
          message: "A folder cannot contain itself"
        }
      });
    }

    if (newParentId) {
      const parent = await pool.query(
        `
        SELECT id
        FROM folders
        WHERE id = $1
          AND owner_id = $2
          AND is_deleted = false
        `,
        [
          newParentId,
          req.user.id
        ]
      );

      if (parent.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: "PARENT_FOLDER_NOT_FOUND",
            message: "Destination folder not found"
          }
        });
      }
    }

    const result = await pool.query(
      `
      UPDATE folders
      SET
        name = $1,
        parent_id = $2,
        updated_at = now()
      WHERE id = $3
        AND owner_id = $4
      RETURNING *
      `,
      [
        safeName,
        newParentId,
        folder.id,
        req.user.id
      ]
    );

    await recordActivity(
      req.user.id,
      name !== undefined ? "rename" : "move",
      folder.id,
      {
        oldName: folder.name,
        newName: safeName,
        oldParentId: folder.parent_id,
        newParentId
      }
    );

    return res.status(200).json({
      folder: result.rows[0]
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: {
          code: "FOLDER_EXISTS",
          message: "A folder with this name already exists"
        }
      });
    }

    console.error("Update folder error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to update folder"
      }
    });
  }
};

const deleteFolder = async (req, res) => {
  try {
    const result = await pool.query(
      `
      UPDATE folders
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
          code: "FOLDER_NOT_FOUND",
          message: "Folder not found"
        }
      });
    }

    await pool.query(
      `
      UPDATE files
      SET
        is_deleted = true,
        updated_at = now()
      WHERE folder_id = $1
        AND owner_id = $2
      `,
      [
        req.params.id,
        req.user.id
      ]
    );

    await recordActivity(
      req.user.id,
      "delete",
      req.params.id,
      {
        name: result.rows[0].name
      }
    );

    return res.status(200).json({
      message: "Folder moved to trash",
      folder: result.rows[0]
    });
  } catch (error) {
    console.error("Delete folder error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to delete folder"
      }
    });
  }
};

const restoreFolder = async (req, res) => {
  try {
    const result = await pool.query(
      `
      UPDATE folders
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
          code: "FOLDER_NOT_FOUND",
          message: "Deleted folder not found"
        }
      });
    }

    await pool.query(
      `
      UPDATE files
      SET
        is_deleted = false,
        updated_at = now()
      WHERE folder_id = $1
        AND owner_id = $2
      `,
      [
        req.params.id,
        req.user.id
      ]
    );

    await recordActivity(
      req.user.id,
      "restore",
      req.params.id,
      {
        name: result.rows[0].name
      }
    );

    return res.status(200).json({
      message: "Folder restored",
      folder: result.rows[0]
    });
  } catch (error) {
    console.error("Restore folder error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to restore folder"
      }
    });
  }
};

const listTrashFolders = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM folders
      WHERE owner_id = $1
        AND is_deleted = true
      ORDER BY updated_at DESC
      `,
      [req.user.id]
    );

    return res.status(200).json({
      folders: result.rows
    });
  } catch (error) {
    console.error("Trash folders error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to load deleted folders"
      }
    });
  }
};

module.exports = {
  createFolder,
  getFolder,
  getRootChildren,
  updateFolder,
  deleteFolder,
  restoreFolder,
  listTrashFolders
};