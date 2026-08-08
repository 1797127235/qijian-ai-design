import { useEffect } from "react";
import { X } from "lucide-react";

export function ImageLightbox({
  url,
  alt = "大图",
  closing = false,
  onClose,
}: {
  url: string;
  alt?: string;
  closing?: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={`image-lightbox-overlay${closing ? " closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="查看大图"
      onClick={onClose}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button type="button" className="image-lightbox-close" aria-label="关闭" onClick={onClose}>
        <X size={18} />
      </button>
      <img
        src={url}
        alt={alt}
        className="image-lightbox-img"
        draggable={false}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
