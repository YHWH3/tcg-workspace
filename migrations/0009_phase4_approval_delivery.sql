-- Approval authority and recoverable recipient delivery commit together.
CREATE TRIGGER approval_requested_outbox AFTER INSERT ON approvals BEGIN
  INSERT OR IGNORE INTO event_outbox(id,payload,created_at) VALUES (
    'ev_approval_requested_'||NEW.id,
    json_object('source','automation','userId',NEW.requested_by,'applied',json('[]'),'extra',json('[]'),
      'notifications',json_array(json_object('userId',NEW.approver_id,'kind','approval_requested',
        'actorId',NEW.requested_by,'targetType',NEW.target_type,'targetId',NEW.target_id,
        'title','Approval requested: '||COALESCE((SELECT json_extract(data,'$.title') FROM records WHERE id=NEW.target_id),NEW.target_id),
        'body',NEW.note,'url',CASE WHEN NEW.target_type='page' THEN '/pages/' ELSE '/tasks/' END||NEW.target_id,
        'groupKey','approval:'||NEW.id,'dedupeKey','approval_requested:'||NEW.id))),NEW.created_at);
END;

CREATE TRIGGER approval_decided_outbox AFTER UPDATE OF status ON approvals
WHEN OLD.status='pending' AND NEW.status IN ('approved','rejected') BEGIN
  INSERT OR IGNORE INTO event_outbox(id,payload,created_at) VALUES (
    'ev_approval_decided_'||NEW.id,
    json_object('source','automation','userId',NEW.approver_id,'applied',json('[]'),'extra',json('[]'),
      'notifications',json_array(json_object('userId',NEW.requested_by,'kind','approval_decided',
        'actorId',NEW.approver_id,'targetType',NEW.target_type,'targetId',NEW.target_id,
        'title','Approval '||NEW.status||': '||COALESCE((SELECT json_extract(data,'$.title') FROM records WHERE id=NEW.target_id),NEW.target_id),
        'body',NEW.decided_note,'url',CASE WHEN NEW.target_type='page' THEN '/pages/' ELSE '/tasks/' END||NEW.target_id,
        'groupKey','approval:'||NEW.id,'dedupeKey','approval_decided:'||NEW.id))),NEW.decided_at);
END;
