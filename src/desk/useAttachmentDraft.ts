import { useCallback, useEffect, useRef, useState } from "react";
import { api, type StoredFile } from "../lib/api";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_TOTAL_ATTACHMENT_BYTES, validateAttachmentFile } from "./attachments";

export type AttachmentDraftStatus = "queued" | "uploading" | "uploaded" | "error";

export interface AttachmentDraftItem {
  localId: string;
  file: File;
  previewUrl?: string;
  status: AttachmentDraftStatus;
  stored?: StoredFile;
  error?: string;
}

function localId() {
  return globalThis.crypto?.randomUUID?.() ?? `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useAttachmentDraft(projectId: string) {
  const [items, setItems] = useState<AttachmentDraftItem[]>([]);
  const itemsRef = useRef<AttachmentDraftItem[]>([]);
  const queueRef = useRef<string[]>([]);
  const activeRef = useRef(new Map<string, AbortController>());
  const mountedRef = useRef(true);
  const pumpRef = useRef<() => void>(() => undefined);

  const replaceItems = useCallback((update: (current: AttachmentDraftItem[]) => AttachmentDraftItem[]) => {
    const next = update(itemsRef.current);
    itemsRef.current = next;
    if (mountedRef.current) setItems(next);
  }, []);

  const pump = useCallback(() => {
    while (activeRef.current.size < 2 && queueRef.current.length > 0) {
      const nextId = queueRef.current.shift()!;
      const item = itemsRef.current.find((candidate) => candidate.localId === nextId && candidate.status === "queued");
      if (!item) continue;
      const controller = new AbortController();
      activeRef.current.set(nextId, controller);
      replaceItems((current) => current.map((candidate) => candidate.localId === nextId
        ? { ...candidate, status: "uploading", error: undefined }
        : candidate));
      void api.uploadFile(projectId, item.file, controller.signal)
        .then((stored) => {
          replaceItems((current) => current.map((candidate) => candidate.localId === nextId
            ? { ...candidate, status: "uploaded", stored, error: undefined }
            : candidate));
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          replaceItems((current) => current.map((candidate) => candidate.localId === nextId
            ? { ...candidate, status: "error", error: error instanceof Error ? error.message : "上传失败" }
            : candidate));
        })
        .finally(() => {
          activeRef.current.delete(nextId);
          pumpRef.current();
        });
    }
  }, [projectId, replaceItems]);
  pumpRef.current = pump;

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const available = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - itemsRef.current.length);
    let selectedBytes = itemsRef.current.reduce((total, item) => total + item.file.size, 0);
    const accepted = files.slice(0, available).map((file): AttachmentDraftItem => {
      const admissionError = validateAttachmentFile(file);
      const error = admissionError ?? (selectedBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES
        ? "每条消息的附件总大小不能超过 60MB"
        : undefined);
      if (!error) selectedBytes += file.size;
      return {
        localId: localId(),
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        status: error ? "error" : "queued",
        error,
      };
    });
    if (files.length > available) {
      const overflow = files.slice(available).map((file): AttachmentDraftItem => ({
        localId: localId(),
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        status: "error",
        error: `每条消息最多添加 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`,
      }));
      accepted.push(...overflow);
    }
    replaceItems((current) => [...current, ...accepted]);
    queueRef.current.push(...accepted.filter((item) => item.status === "queued").map((item) => item.localId));
    pumpRef.current();
  }, [replaceItems]);

  const remove = useCallback((id: string) => {
    const item = itemsRef.current.find((candidate) => candidate.localId === id);
    if (!item) return;
    activeRef.current.get(id)?.abort();
    activeRef.current.delete(id);
    queueRef.current = queueRef.current.filter((queuedId) => queuedId !== id);
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    if (item.stored) void api.deleteFile(projectId, item.stored.id).catch(() => undefined);
    replaceItems((current) => current.filter((candidate) => candidate.localId !== id));
    pumpRef.current();
  }, [projectId, replaceItems]);

  const retry = useCallback((id: string) => {
    const item = itemsRef.current.find((candidate) => candidate.localId === id);
    if (!item || item.status !== "error" || validateAttachmentFile(item.file)) return;
    const otherBytes = itemsRef.current.reduce((total, candidate) => candidate.localId === id ? total : total + candidate.file.size, 0);
    if (otherBytes + item.file.size > MAX_TOTAL_ATTACHMENT_BYTES) return;
    replaceItems((current) => current.map((candidate) => candidate.localId === id
      ? { ...candidate, status: "queued", error: undefined }
      : candidate));
    queueRef.current.push(id);
    pumpRef.current();
  }, [replaceItems]);

  const clearClaimed = useCallback((localIds: string[]) => {
    const claimed = new Set(localIds);
    for (const item of itemsRef.current) {
      if (claimed.has(item.localId) && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    replaceItems((current) => current.filter((item) => !claimed.has(item.localId)));
  }, [replaceItems]);

  const discardAll = useCallback(() => {
    const current = [...itemsRef.current];
    for (const controller of activeRef.current.values()) controller.abort();
    activeRef.current.clear();
    queueRef.current = [];
    for (const item of current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      if (item.stored) void api.deleteFile(projectId, item.stored.id).catch(() => undefined);
    }
    replaceItems(() => []);
  }, [projectId, replaceItems]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // projectId 变更或 unmount：中止上传、删已上传文件、清草稿，避免旧 file id 带入新项目
      const ownershipProjectId = projectId;
      for (const controller of activeRef.current.values()) controller.abort();
      activeRef.current.clear();
      queueRef.current = [];
      const previous = itemsRef.current;
      itemsRef.current = [];
      for (const item of previous) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        if (item.stored) void api.deleteFile(ownershipProjectId, item.stored.id).catch(() => undefined);
      }
      mountedRef.current = false;
    };
  }, [projectId]);

  return { items, addFiles, remove, retry, clearClaimed, discardAll };
}
