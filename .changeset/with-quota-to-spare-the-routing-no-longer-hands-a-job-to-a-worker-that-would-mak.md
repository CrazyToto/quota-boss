---
bump: patch
section: Changed
---
With quota to spare, the routing no longer hands a job to a worker that would make it more than 90 seconds slower (30 for small, 300 for large jobs); while Claude saves quota, the old limits stay.
