ALTER TABLE projects
  ADD COLUMN attachment_revision INTEGER NOT NULL DEFAULT 0 CHECK (attachment_revision >= 0);

ALTER TABLE tasks
  ADD COLUMN attachment_revision INTEGER NOT NULL DEFAULT 0 CHECK (attachment_revision >= 0);

CREATE TRIGGER project_readme_attachments_bump_revision_insert
AFTER INSERT ON project_readme_attachments
BEGIN
  UPDATE projects SET attachment_revision = attachment_revision + 1 WHERE id = NEW.project_id;
END;

CREATE TRIGGER project_readme_attachments_bump_revision_delete
AFTER DELETE ON project_readme_attachments
BEGIN
  UPDATE projects SET attachment_revision = attachment_revision + 1 WHERE id = OLD.project_id;
END;

CREATE TRIGGER attachments_bump_revision_insert
AFTER INSERT ON attachments
BEGIN
  UPDATE tasks SET attachment_revision = attachment_revision + 1 WHERE id = NEW.task_id;
END;

CREATE TRIGGER attachments_bump_revision_delete
AFTER DELETE ON attachments
BEGIN
  UPDATE tasks SET attachment_revision = attachment_revision + 1 WHERE id = OLD.task_id;
END;
