-- BL-197: while audit_archive_detach() waits for ACCESS EXCLUSIVE on audit_log, its queued request blocks new chainer
-- inserts and readers behind it, so every attempt can add its whole lock_timeout to chain lag. One second keeps a
-- failed attempt well inside the 5 s lag budget (architecture §2.7); audit.archive retries with backoff instead.
alter function audit_archive_detach(text) set lock_timeout = '1s';
