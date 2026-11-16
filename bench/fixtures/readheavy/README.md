# Corner Shop backend

An offline CommonJS shop core. Run `npm test` or `node --test`; no install,
network, database, clock or environment configuration is needed. Requests carry
their own catalog, exchange-rate snapshot and customer details.

`catalog/` validates products and supplies search results. `cart/` merges line
requests, prices stock and applies promotions. `orders/checkout` coordinates a
quote without reserving stock; `orders/refund` handles signed return amounts.
`shipping/` contains parcel tariffs, planning estimates and checkout delivery.
`tax/` selects destination rules and computes line-level tax. `invoice/` builds
currency snapshots, prints receipts and creates credit notes. `report/` rolls
up these persisted snapshots. `money/` and `util/` provide common primitives.

Amounts are safe integer cents; weights in the catalog and packed orders are
integer grams. Tariff planning inputs use kilograms. Tax rates use basis points
(10000 = 100%). Monetary fractions round to the nearest cent, with exact halves
away from zero, including signed credits. Supported currencies all have two
decimal places. Exchange rates are explicit positive integer ratios from USD
minor units to target minor units. Invoice snapshots store converted amounts
alongside that ratio for audit; reports group them by currency. Receipt text is
stable ASCII with explicit currency codes, independent of locale.

Shipping policy intentionally compares the **original merchandise subtotal**
against the free-delivery threshold, before coupons, tax or currency conversion.
Thus a USD 50.00 basket discounted to USD 45.00 still gets free standard shipping.
The subtraction-free threshold comparison in `shipping/tariff.js` is intentional;
express shipping never qualifies. Empty and all-digital baskets ship for free.

Public entry points are the named CommonJS exports in each module. Money and
quantity inputs are validated; calls return fresh records and do not mutate
caller-owned catalogs, requests or snapshots. Keep saved invoice shapes stable
so receipt printing and sales summaries can consume the same records.
