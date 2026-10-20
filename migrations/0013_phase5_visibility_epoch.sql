-- A readable-parent deletion or reference change can revoke inherited access
-- without changing records.space_id. Force protocol-2 snapshot reconciliation
-- rather than leaving old descendants/links in a client's incremental cache.
-- Keep the legacy Core-only transition inactive until permission activation.
CREATE TRIGGER p5_record_visibility AFTER UPDATE OF data,collection ON records
WHEN (SELECT enabled FROM access_state WHERE id=1)=1 AND (
  OLD.collection IS NOT NEW.collection
  OR json_extract(OLD.data,'$.deleted') IS NOT json_extract(NEW.data,'$.deleted')
  OR json_extract(OLD.data,'$.parentId') IS NOT json_extract(NEW.data,'$.parentId')
  OR json_extract(OLD.data,'$.boardId') IS NOT json_extract(NEW.data,'$.boardId')
  OR json_extract(OLD.data,'$.pageId') IS NOT json_extract(NEW.data,'$.pageId')
  OR json_extract(OLD.data,'$.databaseId') IS NOT json_extract(NEW.data,'$.databaseId')
  OR json_extract(OLD.data,'$.targetType') IS NOT json_extract(NEW.data,'$.targetType')
  OR json_extract(OLD.data,'$.targetId') IS NOT json_extract(NEW.data,'$.targetId')
  OR json_extract(OLD.data,'$.parentType') IS NOT json_extract(NEW.data,'$.parentType')
  OR json_extract(OLD.data,'$.fromType') IS NOT json_extract(NEW.data,'$.fromType')
  OR json_extract(OLD.data,'$.fromId') IS NOT json_extract(NEW.data,'$.fromId')
  OR json_extract(OLD.data,'$.toType') IS NOT json_extract(NEW.data,'$.toType')
  OR json_extract(OLD.data,'$.toId') IS NOT json_extract(NEW.data,'$.toId')
  OR json_extract(OLD.data,'$.trigger.databaseId') IS NOT json_extract(NEW.data,'$.trigger.databaseId')
) BEGIN
  UPDATE access_state SET generation=generation+1 WHERE id=1;
END;

CREATE TRIGGER p5_record_delete_visibility AFTER DELETE ON records
WHEN (SELECT enabled FROM access_state WHERE id=1)=1 BEGIN
  UPDATE access_state SET generation=generation+1 WHERE id=1;
END;

-- Epochs are never reused across activation, even on an otherwise idle DB.
CREATE TRIGGER p5_access_activation AFTER UPDATE OF enabled ON access_state
WHEN OLD.enabled IS NOT NEW.enabled BEGIN
  UPDATE access_state SET generation=generation+1 WHERE id=1;
END;
