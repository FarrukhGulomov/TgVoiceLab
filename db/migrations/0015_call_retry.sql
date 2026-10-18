-- Automatic redial of a contact call whose audio never connected: attempt counts 1..3 along a chain; retry_of points at the first failed request.
ALTER TABLE call_requests ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 3);
ALTER TABLE call_requests ADD COLUMN retry_of uuid;
