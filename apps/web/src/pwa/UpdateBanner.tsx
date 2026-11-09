interface UpdateBannerProps {
  onUpdate: () => void;
}

export function UpdateBanner({ onUpdate }: UpdateBannerProps) {
  return (
    <div className="update-banner" role="status">
      <span>有新版本</span>
      <button className="primary" type="button" onClick={onUpdate}>
        点一下更新
      </button>
    </div>
  );
}
