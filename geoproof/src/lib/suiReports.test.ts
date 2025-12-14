import { describe, expect, it } from "vitest";

import {
  bboxIntersects,
  extractCreatedObjectIdsFromTxPage,
  extractFirstCreatedObjectId,
  ownerToAddress,
  parseBboxParam,
} from "./suiReports";

describe("suiReports", () => {
  it("parseBboxParam parses valid bbox", () => {
    expect(parseBboxParam("13.37,52.31,13.63,52.46")).toEqual([13.37, 52.31, 13.63, 52.46]);
  });

  it("parseBboxParam rejects invalid bbox", () => {
    expect(parseBboxParam(null)).toBeNull();
    expect(parseBboxParam("a,b,c,d")).toBeNull();
    expect(parseBboxParam("13,52,13,52")).toBeNull();
    expect(parseBboxParam("13.63,52.31,13.37,52.46")).toBeNull();
  });

  it("bboxIntersects works", () => {
    expect(bboxIntersects([0, 0, 1, 1], [2, 2, 3, 3])).toBe(false);
    expect(bboxIntersects([0, 0, 1, 1], [1, 1, 2, 2])).toBe(true); // touching at corner counts
    expect(bboxIntersects([0, 0, 2, 2], [1, 1, 3, 3])).toBe(true);
  });

  it("extractCreatedObjectIdsFromTxPage extracts created ChangeReport ids", () => {
    const txPage = {
      data: [
        {
          digest: "tx1",
          objectChanges: [
            { type: "created", objectType: "0xabc::geoproof_move::ChangeReport", objectId: "0x1" },
            { type: "mutated", objectType: "0xabc::geoproof_move::ChangeReport", objectId: "0x2" },
          ],
        },
        {
          digest: "tx2",
          objectChanges: [
            { type: "created", objectType: "0xabc::other::Other", objectId: "0x3" },
            { type: "created", objectType: "0xabc::geoproof_move::ChangeReport", objectId: "0x4" },
          ],
        },
      ],
    };

    expect(extractCreatedObjectIdsFromTxPage(txPage, { objectTypeIncludes: "ChangeReport" })).toEqual([
      { objectId: "0x1", digest: "tx1" },
      { objectId: "0x4", digest: "tx2" },
    ]);
  });

  it("extractFirstCreatedObjectId finds created ChangeReport id", () => {
    const changes = [
      { type: "mutated", objectType: "0xabc::geoproof_move::ChangeReport", objectId: "0x2" },
      { type: "created", objectType: "0xabc::geoproof_move::ChangeReport", objectId: "0x9" },
    ];
    expect(extractFirstCreatedObjectId(changes, { objectTypeIncludes: "ChangeReport" })).toBe("0x9");
  });

  it("ownerToAddress extracts AddressOwner", () => {
    expect(ownerToAddress({ AddressOwner: "0x123" })).toBe("0x123");
    expect(ownerToAddress({ ObjectOwner: "0x456" })).toBeNull();
    expect(ownerToAddress(null)).toBeNull();
  });
});
