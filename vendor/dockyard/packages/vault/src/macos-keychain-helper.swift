import Darwin
import Foundation
import Security

struct Request: Decodable {
    let operation: String
    let service: String
    let account: String
    let value: String?
}

struct Response: Encodable {
    let ok: Bool
    let found: Bool?
    let value: String?
}

func writeResponse(_ response: Response) {
    let data = try! JSONEncoder().encode(response)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ status: OSStatus, _ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message) (status \(status))\n".utf8))
    exit(1)
}

func baseQuery(for request: Request) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: request.service,
        kSecAttrAccount as String: request.account,
    ]
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let request: Request
do {
    request = try JSONDecoder().decode(Request.self, from: input)
} catch {
    fail(-1, "Invalid keychain helper request")
}

let query = baseQuery(for: request)

switch request.operation {
case "write":
    guard let value = request.value else { fail(-1, "Missing keychain value") }
    let valueData = Data(value.utf8)
    let attributes: [String: Any] = [kSecValueData as String: valueData]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        item[kSecValueData as String] = valueData
        status = SecItemAdd(item as CFDictionary, nil)
    }
    guard status == errSecSuccess else { fail(status, "Keychain write failed") }
    writeResponse(Response(ok: true, found: nil, value: nil))
case "read":
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecItemNotFound {
        writeResponse(Response(ok: true, found: false, value: nil))
    } else {
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            fail(status, "Keychain read failed")
        }
        writeResponse(Response(ok: true, found: true, value: value))
    }
case "delete":
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { fail(status, "Keychain delete failed") }
    writeResponse(Response(ok: true, found: nil, value: nil))
default:
    fail(-1, "Unknown keychain helper operation")
}
