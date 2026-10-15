-- Thumbnail pointers are read capabilities for auxiliary bytes. Removing or
-- changing one must reconcile cached bytes just like changing a file parent.
-- Keep the legacy Core-only transition inactive until permission activation.
CREATE TRIGGER p5_file_aux_visibility AFTER UPDATE OF data ON records
WHEN NEW.collection='files' AND (SELECT enabled FROM access_state WHERE id=1)=1
  AND json_extract(OLD.data,'$.thumbId') IS NOT json_extract(NEW.data,'$.thumbId')
BEGIN
  UPDATE access_state SET generation=generation+1 WHERE id=1;
END;
