-- NULL preserves legacy runs. Branches store a zero-based index, with -1 for Otherwise.
ALTER TABLE automation_runs ADD COLUMN branch INTEGER
 CHECK(branch IS NULL OR branch BETWEEN -1 AND 4);
