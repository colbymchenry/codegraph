DROP TRIGGER release_owner;
CREATE TRIGGER release_owner BEFORE INSERT ON releases BEGIN INSERT OR IGNORE INTO extensions(id,publisher) VALUES(NEW.id,NEW.publisher); SELECT CASE WHEN (SELECT publisher FROM extensions WHERE id=NEW.id) != NEW.publisher THEN RAISE(ABORT,'Extension id belongs to another publisher') END; END;
INSERT INTO registry_meta(key,value) VALUES('official_operator','1');
