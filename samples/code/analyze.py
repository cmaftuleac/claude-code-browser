"""Toy data analysis sample."""

from __future__ import annotations
import csv
from pathlib import Path


def total_by_country(path: Path) -> dict[str, float]:
    totals: dict[str, float] = {}
    with path.open(newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            country = row["country"]
            totals[country] = totals.get(country, 0.0) + float(row["total"])
    return totals


if __name__ == "__main__":
    sales = Path(__file__).resolve().parent.parent / "data" / "sales.csv"
    for country, total in sorted(total_by_country(sales).items(), key=lambda kv: -kv[1]):
        print(f"{country:>4}  ${total:>10,.2f}")
