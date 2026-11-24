CREATE TABLE analytics_views (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  referrer TEXT NOT NULL,
  views INTEGER NOT NULL,
  PRIMARY KEY (day, path, referrer)
);
-- statement-breakpoint
CREATE TABLE analytics_visitors (
  day TEXT NOT NULL,
  visitor TEXT NOT NULL,
  PRIMARY KEY (day, visitor)
);
-- statement-breakpoint
CREATE TABLE analytics_days (
  day TEXT PRIMARY KEY NOT NULL,
  visitors INTEGER NOT NULL
);
