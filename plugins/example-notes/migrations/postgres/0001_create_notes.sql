CREATE TABLE example_notes_items (
  id serial PRIMARY KEY,
  owner_id integer NOT NULL,
  body text NOT NULL,
  created_at text NOT NULL
);
-- statement-breakpoint
CREATE INDEX example_notes_items_owner ON example_notes_items (owner_id);
