-- Sample schema for the orders + customers demo.

CREATE TABLE customers (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  country       CHAR(2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE orders (
  id            SERIAL PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product       TEXT NOT NULL,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  unit_price    NUMERIC(10, 2) NOT NULL,
  total         NUMERIC(12, 2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  placed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX orders_customer_idx ON orders(customer_id);
CREATE INDEX orders_placed_idx   ON orders(placed_at DESC);

-- A simple aggregate view.
CREATE VIEW orders_by_country AS
  SELECT c.country, SUM(o.total) AS revenue
  FROM   orders o JOIN customers c ON c.id = o.customer_id
  GROUP  BY c.country
  ORDER  BY revenue DESC;
