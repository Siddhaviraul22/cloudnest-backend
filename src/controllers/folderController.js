const { pool } = require("../config/database");

const getFolderPermission = async (
  folderId,
  userId
) => {
  const result = await pool.query(
    `
    WITH RECURSIVE ancestors AS (
      SELECT
        id,
        parent_id,
        owner_id
      FROM folders
      WHERE id = $1

      UNION ALL

      SELECT
        f.id,
        f.parent_id,
        f.owner_id
      FROM folders f
      INNER JOIN ancestors a
        ON f.id = a.parent_id
    )
    SELECT
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM ancestors
          WHERE owner_id = $2
        )
        THEN 'owner'

        WHEN EXISTS (
          SELECT 1
          FROM shares s
          INNER JOIN ancestors a
            ON a.id = s.resource_id
          WHERE s.resource_type = 'folder'
            AND s.grantee_user_id = $2
            AND s.role = 'editor'
        )
        THEN 'editor'

        WHEN EXISTS (
          SELECT 1
          FROM shares s
          INNER JOIN ancestors a
            ON a.id = s.resource_id
          WHERE s.resource_type = 'folder'
            AND s.grantee_user_id = $2
            AND s.role = 'viewer'
        )
        THEN 'viewer'

        ELSE NULL
      END AS permission
    `,
    [
      folderId,
      userId
    ]
  );

  return result.rows[0]?.permission || null;
};

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

    const safeName =
      sanitizeFolderName(name || "");

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
        [
          parentId,
          req.user.id
        ]
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

    /*
     * Prevent duplicate folder names
     * inside the same parent folder.
     */
    const duplicate = await pool.query(
      `
      SELECT id
      FROM folders
      WHERE owner_id = $1
        AND parent_id IS NOT DISTINCT FROM $2
        AND name = $3
        AND is_deleted = false
      LIMIT 1
      `,
      [
        req.user.id,
        parentId,
        safeName
      ]
    );

    if (duplicate.rows.length > 0) {
      return res.status(409).json({
        error: {
          code: "FOLDER_EXISTS",
          message:
            "A folder with this name already exists in this location"
        }
      });
    }

    /*
     * A newly created folder cannot create
     * a circular relationship because it does
     * not yet have any children.
     *
     * Circular relationships are checked when
     * an existing folder is moved.
     */

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
          message:
            "A folder with this name already exists in this location"
        }
      });
    }

    console.error(
      "Create folder error:",
      error
    );

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message:
          "Unable to create folder"
      }
    });
  }
};

const getFolder = async (req, res) => {
  try {
    const folderId =
      req.params.id;

    const permission =
      await getFolderPermission(
        folderId,
        req.user.id
      );

    if (!permission) {
      return res.status(404).json({
        error: {
          code: "FOLDER_NOT_FOUND",
          message: "Folder not found"
        }
      });
    }

    const folderResult =
      await pool.query(
        `
        SELECT *
        FROM folders
        WHERE id = $1
          AND is_deleted = false
        `,
        [folderId]
      );

    if (
      folderResult.rows.length === 0
    ) {
      return res.status(404).json({
        error: {
          code: "FOLDER_NOT_FOUND",
          message: "Folder not found"
        }
      });
    }

    const folder =
      folderResult.rows[0];

    const folders =
      await pool.query(
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
        WHERE f.owner_id = $2
          AND f.parent_id = $3
          AND f.is_deleted = false
        ORDER BY f.name ASC
        `,
        [
          req.user.id,
          folder.owner_id,
          folderId
        ]
      );

    const files =
      await pool.query(
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
        WHERE f.owner_id = $2
          AND f.folder_id = $3
          AND f.is_deleted = false
        ORDER BY f.name ASC
        `,
        [
          req.user.id,
          folder.owner_id,
          folderId
        ]
      );

    const path = [];

    let currentId =
      folderId;

    while (currentId) {
      const current =
        await pool.query(
          `
          SELECT
            id,
            name,
            parent_id
          FROM folders
          WHERE id = $1
            AND owner_id = $2
            AND is_deleted = false
          `,
          [
            currentId,
            folder.owner_id
          ]
        );

      if (
        current.rows.length === 0
      ) {
        break;
      }

      path.unshift(
        current.rows[0]
      );

      currentId =
        current.rows[0].parent_id;
    }

    return res.status(200).json({
      folder,
      permission,
      children: {
        folders:
          folders.rows,
        files:
          files.rows
      },
      path
    });
  } catch (error) {
    console.error(
      "Get folder error:",
      error
    );

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

    /*
     * A folder cannot be its own parent.
     */
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

      /*
       * Prevent circular folder relationships.
       *
       * Example:
       * A -> B -> C
       *
       * A cannot be moved inside B or C.
       */
      const circularCheck = await pool.query(
        `
        WITH RECURSIVE descendants AS (
          SELECT id
          FROM folders
          WHERE id = $1
            AND owner_id = $2

          UNION ALL

          SELECT f.id
          FROM folders f
          INNER JOIN descendants d
            ON f.parent_id = d.id
          WHERE f.owner_id = $2
        )
        SELECT id
        FROM descendants
        WHERE id = $3
        LIMIT 1
        `,
        [
          folder.id,
          req.user.id,
          newParentId
        ]
      );

      if (circularCheck.rows.length > 0) {
        return res.status(400).json({
          error: {
            code: "CIRCULAR_FOLDER_RELATIONSHIP",
            message:
              "A folder cannot be moved inside one of its own subfolders"
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
    const folderId = req.params.id;
    const ownerId = req.user.id;

    const folderResult = await pool.query(
      `
      SELECT id, name
      FROM folders
      WHERE id = $1
        AND owner_id = $2
        AND is_deleted = false
      `,
      [folderId, ownerId]
    );

    if (folderResult.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "FOLDER_NOT_FOUND",
          message: "Folder not found"
        }
      });
    }

    /*
     * Find the selected folder and every
     * folder underneath it.
     */
    const descendantFolders = await pool.query(
      `
      WITH RECURSIVE folder_tree AS (
        SELECT id
        FROM folders
        WHERE id = $1
          AND owner_id = $2

        UNION ALL

        SELECT f.id
        FROM folders f
        INNER JOIN folder_tree ft
          ON f.parent_id = ft.id
        WHERE f.owner_id = $2
      )
      SELECT id
      FROM folder_tree
      `,
      [folderId, ownerId]
    );

    const folderIds =
      descendantFolders.rows.map(
        (row) => row.id
      );

    /*
     * Move the entire folder tree to Trash.
     */
    await pool.query(
      `
      UPDATE folders
      SET
        is_deleted = true,
        updated_at = now()
      WHERE id = ANY($1::uuid[])
        AND owner_id = $2
      `,
      [folderIds, ownerId]
    );

    /*
     * Move all files inside the folder tree
     * to Trash as well.
     */
    await pool.query(
      `
      UPDATE files
      SET
        is_deleted = true,
        updated_at = now()
      WHERE folder_id = ANY($1::uuid[])
        AND owner_id = $2
      `,
      [folderIds, ownerId]
    );

    await recordActivity(
      ownerId,
      "delete",
      folderId,
      {
        name: folderResult.rows[0].name
      }
    );

    return res.status(200).json({
      message: "Folder moved to trash",
      folder: {
        ...folderResult.rows[0],
        is_deleted: true
      }
    });
  } catch (error) {
    console.error(
      "Delete folder error:",
      error
    );

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
    const folderId = req.params.id;
    const ownerId = req.user.id;

    const folderResult = await pool.query(
      `
      SELECT id, name
      FROM folders
      WHERE id = $1
        AND owner_id = $2
        AND is_deleted = true
      `,
      [folderId, ownerId]
    );

    if (folderResult.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "FOLDER_NOT_FOUND",
          message: "Deleted folder not found"
        }
      });
    }

    /*
     * Find the selected folder and every
     * deleted folder underneath it.
     */
    const descendantFolders = await pool.query(
      `
      WITH RECURSIVE folder_tree AS (
        SELECT id
        FROM folders
        WHERE id = $1
          AND owner_id = $2
          AND is_deleted = true

        UNION ALL

        SELECT f.id
        FROM folders f
        INNER JOIN folder_tree ft
          ON f.parent_id = ft.id
        WHERE f.owner_id = $2
          AND f.is_deleted = true
      )
      SELECT id
      FROM folder_tree
      `,
      [folderId, ownerId]
    );

    const folderIds =
      descendantFolders.rows.map(
        (row) => row.id
      );

    /*
     * Restore the entire folder tree.
     */
    await pool.query(
      `
      UPDATE folders
      SET
        is_deleted = false,
        updated_at = now()
      WHERE id = ANY($1::uuid[])
        AND owner_id = $2
      `,
      [folderIds, ownerId]
    );

    /*
     * Restore all files belonging to
     * those folders.
     */
    await pool.query(
      `
      UPDATE files
      SET
        is_deleted = false,
        updated_at = now()
      WHERE folder_id = ANY($1::uuid[])
        AND owner_id = $2
      `,
      [folderIds, ownerId]
    );

    await recordActivity(
      ownerId,
      "restore",
      folderId,
      {
        name: folderResult.rows[0].name
      }
    );

    return res.status(200).json({
      message: "Folder restored",
      folder: {
        ...folderResult.rows[0],
        is_deleted: false
      }
    });
  } catch (error) {
    console.error(
      "Restore folder error:",
      error
    );

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to restore folder"
      }
    });
  }
};

const permanentlyDeleteFolder = async (req, res) => {
  try {
    const folderId = req.params.id;
    const ownerId = req.user.id;

    const folderResult = await pool.query(
      `
      SELECT id, name
      FROM folders
      WHERE id = $1
        AND owner_id = $2
        AND is_deleted = true
      `,
      [folderId, ownerId]
    );

    if (folderResult.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: "FOLDER_NOT_FOUND",
          message: "Deleted folder not found"
        }
      });
    }

    const descendantFolders = await pool.query(
      `
      WITH RECURSIVE folder_tree AS (
        SELECT id
        FROM folders
        WHERE id = $1
          AND owner_id = $2

        UNION ALL

        SELECT f.id
        FROM folders f
        INNER JOIN folder_tree ft
          ON f.parent_id = ft.id
        WHERE f.owner_id = $2
      )
      SELECT id
      FROM folder_tree
      `,
      [folderId, ownerId]
    );

    const folderIds =
      descendantFolders.rows.map(
        (row) => row.id
      );
await recordActivity(
      ownerId,
      "delete",
      folderId,
      {
        name: folderResult.rows[0].name
      }
    );
    await pool.query(
      `
      DELETE FROM files
      WHERE folder_id = ANY($1::uuid[])
        AND owner_id = $2
      `,
      [folderIds, ownerId]
    );

    await pool.query(
      `
      DELETE FROM folders
      WHERE id = ANY($1::uuid[])
        AND owner_id = $2
      `,
      [folderIds, ownerId]
    );

    

    return res.status(200).json({
      message: "Folder permanently deleted"
    });
  } catch (error) {
    console.error(
      "Permanent folder delete error:",
      error
    );

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to permanently delete folder"
      }
    });
  }
};
const starFolder = async (req, res) => {
  try {
    const folderId = req.params.id;

    const folderResult = await pool.query(
      `
      SELECT id, name
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

    await pool.query(
      `
      INSERT INTO stars
        (user_id, resource_type, resource_id)
      VALUES
        ($1, 'folder', $2)
      ON CONFLICT (
        user_id,
        resource_type,
        resource_id
      )
      DO NOTHING
      `,
      [
        req.user.id,
        folderId
      ]
    );

    return res.status(200).json({
      message: "Folder starred"
    });
  } catch (error) {
    console.error(
      "Star folder error:",
      error
    );

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to star folder"
      }
    });
  }
};

const unstarFolder = async (req, res) => {
  try {
    const folderId = req.params.id;

    await pool.query(
      `
      DELETE FROM stars
      WHERE user_id = $1
        AND resource_type = 'folder'
        AND resource_id = $2
      `,
      [
        req.user.id,
        folderId
      ]
    );

    return res.status(200).json({
      message: "Folder unstarred"
    });
  } catch (error) {
    console.error(
      "Unstar folder error:",
      error
    );

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unable to unstar folder"
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
  permanentlyDeleteFolder,
  starFolder,
  unstarFolder,
  listTrashFolders
};