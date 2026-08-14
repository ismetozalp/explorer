#!/usr/bin/env python3
"""sample.py - synthetic Python file for Explorer preview testing."""

from dataclasses import dataclass


@dataclass
class Item:
    id: int
    label: str


def describe(item: Item) -> str:
    return f"#{item.id}: {item.label}"


def main() -> None:
    items = [Item(1, "Apple"), Item(2, "Banana"), Item(3, "Grape")]
    for item in items:
        print(describe(item))


if __name__ == "__main__":
    main()
