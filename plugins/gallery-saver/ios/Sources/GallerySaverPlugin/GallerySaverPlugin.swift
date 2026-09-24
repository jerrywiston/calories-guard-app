import Foundation
import Capacitor
import Photos

@objc(GallerySaverPlugin)
public class GallerySaverPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GallerySaverPlugin"
    public let jsName = "GallerySaver"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveImage", returnType: CAPPluginReturnPromise)
    ]

    @objc func saveImage(_ call: CAPPluginCall) {
        guard let encoded = call.getString("data"),
              let imageData = Data(base64Encoded: encoded),
              !imageData.isEmpty else {
            call.reject("圖片資料不完整，無法存到相簿。")
            return
        }

        let filename = sanitizeFilename(call.getString("filename") ?? "營養紀錄.png")
        let replaceIdentifier = call.getString("replaceIdentifier") ?? ""
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
            guard status == .authorized || status == .limited else {
                call.reject("沒有相簿新增權限，請到系統設定允許後再試。")
                return
            }

            var localIdentifier = ""
            PHPhotoLibrary.shared().performChanges({
                if !replaceIdentifier.isEmpty {
                    let previous = PHAsset.fetchAssets(withLocalIdentifiers: [replaceIdentifier], options: nil)
                    if let asset = previous.firstObject {
                        PHAssetChangeRequest.deleteAssets([asset] as NSArray)
                    }
                }
                let request = PHAssetCreationRequest.forAsset()
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = filename
                request.addResource(with: .photo, data: imageData, options: options)
                localIdentifier = request.placeholderForCreatedAsset?.localIdentifier ?? ""
            }) { success, error in
                if success {
                    call.resolve(["uri": localIdentifier])
                } else {
                    call.reject("無法將圖片存到手機相簿，請確認相簿權限與儲存空間。", nil, error)
                }
            }
        }
    }

    private func sanitizeFilename(_ filename: String) -> String {
        let forbidden = CharacterSet(charactersIn: "\\/:*?\"<>|\r\n")
        let safe = filename.components(separatedBy: forbidden).joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let base = safe.isEmpty ? "營養紀錄.png" : safe
        return base.lowercased().hasSuffix(".png") ? base : base + ".png"
    }
}
