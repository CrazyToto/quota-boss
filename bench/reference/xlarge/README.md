# Inventory

Small inventory tool. Money values are integer cents.

## Usage

```
node src/cli.js db.json import items.csv
node src/cli.js db.json list
node src/cli.js db.json quote ABC-001:2 --coupon SAVE5
node src/cli.js db.json report
```

node src/cli.js db.json order ABC-001:2 --coupon HALF
node src/cli.js db.json cancel ORD-0001
