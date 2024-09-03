"use client";

import { FileInfo } from "@/components/file-info";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { encryptMessage } from "@/lib/crypto";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Peer from "simple-peer";
import { z } from "zod";

const UserSchema = z.object({
	id: z.number(),
	nickname: z.string(),
	publicKey: z.string(),
});

const WSMessageSchema = z.object({
	type: z.string(),
	senderId: z.number(),
	receiverId: z.number(),
	body: z.string(),
	aesKeySender: z.string().optional(),
	aesKeyReceiver: z.string().optional(),
	messageId: z.number().optional(),
	state: z.string().optional(),
	fileAttachments: z.string().optional(),
});

type WSMessage = z.infer<typeof WSMessageSchema>;

const FileUploadSchema = z.object({
	fileName: z.string(),
	fileSize: z.number(),
	fileType: z.string(),
	fileUrl: z.string(),
});

type FileUpload = z.infer<typeof FileUploadSchema>;

const FileUploadsSchema = z.array(FileUploadSchema);

type FileUploads = z.infer<typeof FileUploadsSchema>;

const MessageSchema = z.object({
	id: z.number(),
	senderId: z.number(),
	receiverId: z.number(),
	body: z.string(),
	state: z.string(),
	expiredAt: z.string(),
	createdAt: z.string().optional(),
	aesKeyReceiver: z.string().optional(),
	aesKeySender: z.string().optional(),
	fileAttachments: FileUploadsSchema.nullable().optional(),
});

type Message = z.infer<typeof MessageSchema>;

const MessageResponseSchema = z.array(MessageSchema);

type MessageResponse = z.infer<typeof MessageResponseSchema>;

const SignalMessageSchema = z.object({
	type: z.union([
		z.literal("signal"),
		z.literal("video-call"),
		z.literal("end"),
	]),
	signal: z.any().nullable(),
	from: z.string().optional(),
});

type SignalMessage = z.infer<typeof SignalMessageSchema>;

export default function Chat() {
	const [nickname, setNickname] = useState("");
	const [messages, setMessages] = useState<MessageResponse>([]);
	const [partnerId, setPartnerId] = useState("");
	const [partnerPublicKey, setPartnerPublicKey] = useState("");
	const [userId, setUserId] = useState("");
	const [newMessage, setNewMessage] = useState("");
	const [token, setToken] = useState("");
	const [privateKey, setPrivateKey] = useState("");
	const [publicKey, setPublicKey] = useState("");
	const [fileUploads, setFileUploads] = useState<FileUploads>([]);
	const router = useRouter();
	const { toast } = useToast();
	const messagesEndRef = useRef<HTMLDivElement>(null);

	const wsRef = useRef<WebSocket | null>(null);
	const remoteAudioRef = useRef<HTMLAudioElement>(null);
	const remoteVideoRef = useRef<HTMLVideoElement>(null);
	const socketCallRef = useRef<WebSocket | null>(null);

	const [isAlertOpen, setIsAlertOpen] = useState(false);
	const [pendingCallMessage, setPendingCallMessage] =
		useState<SignalMessage | null>(null);

	const [peerConnection, setPeerConnection] = useState<Peer.Instance | null>(
		null,
	);
	const [localStream, setLocalStream] = useState<MediaStream | null>(null);
	const [isVideoCall, setIsVideoCall] = useState<boolean>(false);
	const [isWebSocketReady, setIsWebSocketReady] = useState(false);

	const sendStatusUpdate = useCallback((messageId: number, state: string) => {
		console.log("Sending status update:", messageId, state);
		if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
			console.log("WebSocket is open, sending state update");
			wsRef.current.send(
				JSON.stringify({
					type: "status_update",
					messageId: messageId,
					state: state,
				}),
			);
		}
	}, []);

	useEffect(() => {
		const fetchPartnerInfo = async () => {
			try {
				const response = await fetch(
					`http://localhost:8000/api/users/${partnerId}`,
					{
						headers: { Authorization: `Bearer ${token}` },
					},
				);
				if (response.ok) {
					const responseData = await response.json();
					const { data, success } = UserSchema.safeParse(responseData);
					if (success) {
						setPartnerPublicKey(data.publicKey);
						fetchMessages();
					} else {
						toast({
							title: "No partner valid",
						});
					}
				} else {
					toast({
						title: "No partner found",
					});
				}
			} catch (error) {
				console.error("Error fetching partner info:", error);
				toast({
					title: "Error",
					description: "Please try again. Failed to fetch partner info",
					variant: "destructive",
				});
			}
		};

		const fetchMessages = async () => {
			try {
				const response = await fetch(
					`http://localhost:8000/api/messages?partner_id=${partnerId}`,
					{
						headers: { Authorization: `Bearer ${token}` },
					},
				);
				if (response.ok) {
					const dataResponse = await response.json();
					const { data, success } =
						MessageResponseSchema.safeParse(dataResponse);
					if (success) {
						const decryptedMessages = await Promise.all(
							data.map(async (message) => {
								if (
									message.receiverId === Number(userId) &&
									message.aesKeyReceiver
								) {
									const response = await fetch("/api/decrypt", {
										method: "POST",
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify({
											encryptedMessage: message.body,
											encryptedAESKey: message.aesKeyReceiver,
											privateKey,
											fileUploads: message.fileAttachments ?? [],
										}),
									});
									const { decryptedMessage, decryptedFileUploads } =
										await response.json();
									message.body = decryptedMessage;
									message.fileAttachments = decryptedFileUploads;
								} else if (
									message.senderId === Number(userId) &&
									message.aesKeySender
								) {
									const response = await fetch("/api/decrypt", {
										method: "POST",
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify({
											encryptedMessage: message.body,
											encryptedAESKey: message.aesKeySender,
											privateKey,
											fileUploads: message.fileAttachments ?? [],
										}),
									});
									const { decryptedMessage, decryptedFileUploads } =
										await response.json();
									message.body = decryptedMessage;
									message.fileAttachments = decryptedFileUploads;
								}

								if (
									message.state === "sent" &&
									message.senderId !== Number(userId)
								) {
									message.state = "received";
									sendStatusUpdate(message.id, "received");
								}
								return message;
							}),
						);
						setMessages(decryptedMessages);
					} else {
						setMessages([]);
						toast({
							title: "No messages found",
						});
					}
				} else {
					setMessages([]);
					toast({
						title: "Fetch messages failed",
					});
				}
			} catch (error) {
				console.error("Error fetching messages:", error);
				toast({
					title: "Error",
					description: JSON.stringify(error),
					variant: "destructive",
				});
			}
		};

		if (partnerId && token && privateKey && userId) {
			fetchPartnerInfo();
		}
	}, [partnerId, toast, token, privateKey, userId, sendStatusUpdate]);

	const handleNewMessage = useCallback(
		async (data: WSMessage) => {
			console.log("New message received:", data);
			try {
				let decryptedContent = data.body;
				let decryptedFileUploads: FileUploads = [];
				if (data.receiverId === Number(userId) && data.aesKeyReceiver) {
					const response = await fetch("/api/decrypt", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							encryptedMessage: data.body,
							encryptedAESKey: data.aesKeyReceiver,
							privateKey,
							fileUploads: data.fileAttachments ?? [],
						}),
					});
					const { decryptedMessage, decryptedFileUploads: fileUploads } =
						await response.json();
					decryptedContent = decryptedMessage;
					decryptedFileUploads = fileUploads;
				} else if (data.senderId === Number(userId) && data.aesKeySender) {
					const response = await fetch("/api/decrypt", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							encryptedMessage: data.body,
							encryptedAESKey: data.aesKeySender,
							privateKey,
							fileUploads: data.fileAttachments ?? [],
						}),
					});
					const { decryptedMessage, decryptedFileUploads: fileUploads } =
						await response.json();
					decryptedContent = decryptedMessage;
					decryptedFileUploads = fileUploads;
				}

				let parsedFileAttachments: FileUploads = [];
				if (decryptedFileUploads.length > 0) {
					try {
						const { data: attachments, success } =
							FileUploadsSchema.safeParse(decryptedFileUploads);
						if (success) {
							parsedFileAttachments = attachments;
						}
					} catch (error) {
						console.error("Error parsing file attachments:", error);
					}
				}

				const newMessage: Message = {
					id: data.messageId ?? -1,
					senderId: data.senderId,
					receiverId: data.receiverId,
					body: decryptedContent,
					state: "received",
					expiredAt: new Date().toISOString(),
					aesKeyReceiver: data.aesKeyReceiver,
					aesKeySender: data.aesKeySender,
					fileAttachments: parsedFileAttachments,
				};

				setMessages((prev) => [...prev, newMessage]);

				if (data.messageId) {
					sendStatusUpdate(data.messageId, "received");
				}
			} catch (error) {
				console.error("Error processing new message:", error);
				toast({
					title: "Error",
					description: "Failed to process new message",
					variant: "destructive",
				});
			}
		},
		[privateKey, toast, sendStatusUpdate, userId],
	);

	const handleStatusUpdate = useCallback((data: WSMessage) => {
		console.log("Status update:", data.state, data.messageId);
		setMessages((prev) =>
			prev.map((message) => {
				if (message.id === data.messageId) {
					return { ...message, state: data.state || "sent" };
				}
				return message;
			}),
		);
	}, []);

	const handleMessageSent = useCallback((data: WSMessage) => {
		console.log("Message sent:", data.state);
		setMessages((prev) =>
			prev.map((message) =>
				message.id === -1
					? {
							...message,
							status: data.state || "sent",
							id: data.messageId ?? -1,
						}
					: message,
			),
		);
	}, []);

	useEffect(() => {
		const token = localStorage.getItem("token");
		const userId = localStorage.getItem("user_id");
		const nickname = localStorage.getItem("nickname");
		const privateKey = localStorage.getItem(`private_key_${userId}`);
		const publicKey = localStorage.getItem(`public_key_${userId}`);

		if (!token || !userId || !nickname || !privateKey || !publicKey) {
			router.push("/login");
			return;
		}
		setToken(token);
		setUserId(userId);
		setNickname(nickname);
		setPrivateKey(privateKey);
		setPublicKey(publicKey);

		const websocket = new WebSocket(`ws://localhost:8000/ws?token=${token}`);
		wsRef.current = websocket;

		websocket.onopen = () => {
			console.log("WebSocket connection established");
			setIsWebSocketReady(true);
		};

		websocket.onmessage = async (event) => {
			console.log("WebSocket message received:", event.data);
			const { data, success } = WSMessageSchema.safeParse(
				JSON.parse(event.data),
			);
			console.log("WebSocket message received:", data);
			if (success) {
				switch (data.type) {
					case "new_message":
						await handleNewMessage(data);
						break;
					case "message_sent":
						handleMessageSent(data);
						break;
					case "status_update":
						handleStatusUpdate(data);
						break;
					default:
						console.log("Unknown message type:", data.type);
				}
			}
		};

		websocket.onerror = (event) => {
			console.error("WebSocket error:", event);
			setIsWebSocketReady(false);
		};

		websocket.onclose = (event) => {
			console.log("WebSocket connection closed:", event);
			setIsWebSocketReady(false);
		};

		setupSignaling(token);

		if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
			console.error("getUserMedia is not supported in this browser");
		}

		return () => {
			if (websocket) websocket.close();
			if (socketCallRef.current) socketCallRef.current.close();
		};
	}, [router, handleNewMessage, handleStatusUpdate, handleMessageSent]);

	const setupSignaling = (token: string) => {
		socketCallRef.current = new WebSocket(
			`ws://localhost:8000/ws/webrtc?token=${token}`,
		);
		socketCallRef.current.onopen = () =>
			console.log("WebSocket call connection established");
		socketCallRef.current.onmessage = (event) => {
			const message = JSON.parse(event.data);
			console.log("WebSocket call message received:", message);
			if (
				(message.type === "signal" || message.type === "video-call") &&
				message.signal
			) {
				if (peerConnection) {
					peerConnection.signal(message.signal);
				} else {
					message.type === "video-call"
						? handleIncomingVideoCall(message)
						: handleIncomingCall(message);
				}
			}
			if (message.type === "end") {
				console.log("Ending call");
				endCall();
			}
		};
	};

	const checkAndRequestPermissions = async (isVideo: boolean) => {
		try {
			await navigator.mediaDevices.getUserMedia({
				audio: true,
				video: isVideo,
			});
			console.log("Permissions granted");
		} catch (error) {
			console.error("Error requesting permissions:", error);
			toast({
				title: "Permission Error",
				description:
					"Please grant microphone and camera permissions to use this feature.",
				variant: "destructive",
			});
			throw error;
		}
	};

	const startCall = async (isVideo = false): Promise<void> => {
		try {
			await checkAndRequestPermissions(isVideo);
			setIsVideoCall(isVideo);
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: true,
				video: isVideo,
			});
			setLocalStream(stream);
			const peer = new Peer({ initiator: true, stream, trickle: false });

			// biome-ignore lint/suspicious/noExplicitAny: <explanation>
			peer.on("signal", (data: any) => {
				console.log("Signal received:", data);
				sendSignalingMessage({
					type: isVideo ? "video-call" : "signal",
					signal: data,
					to: partnerId,
				});
			});

			peer.on("stream", (stream: MediaStream) => {
				if (isVideo && remoteVideoRef.current) {
					remoteVideoRef.current.srcObject = stream;
					remoteVideoRef.current.style.display = "block";
					if (remoteAudioRef.current)
						remoteAudioRef.current.style.display = "none";
				} else if (remoteAudioRef.current) {
					remoteAudioRef.current.srcObject = stream;
				}
			});

			setPeerConnection(peer);
		} catch (error) {
			console.error("Error in startCall:", error);
		}
	};

	const endCall = (): void => {
		if (peerConnection) {
			sendSignalingMessage({
				type: "end",
				signal: null,
				to: partnerId,
			});
			peerConnection.destroy();
			setPeerConnection(null);
		}
		if (localStream) {
			// biome-ignore lint/complexity/noForEach: <explanation>
			localStream.getTracks().forEach((track) => track.stop());
			setLocalStream(null);
		}
		if (remoteAudioRef.current) remoteAudioRef.current.style.display = "block";
		if (remoteVideoRef.current) remoteVideoRef.current.style.display = "none";
		setIsVideoCall(false);
	};
	const getMedia = async (
		message: SignalMessage,
		isVideo: boolean,
	): Promise<void> => {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: true,
				video: isVideo,
			});
			setLocalStream(stream);
			setIsVideoCall(isVideo);

			const peer = new Peer({ initiator: false, stream, trickle: false });

			// biome-ignore lint/suspicious/noExplicitAny: <explanation>
			peer.on("signal", (data: any) => {
				sendSignalingMessage({
					type: "accept-call",
					signal: data,
					to: message.from,
				});
			});

			peer.on("stream", (remoteStream: MediaStream) => {
				if (isVideo && remoteVideoRef.current) {
					remoteVideoRef.current.srcObject = remoteStream;
					remoteVideoRef.current.style.display = "block";
					if (remoteAudioRef.current)
						remoteAudioRef.current.style.display = "none";
				} else if (remoteAudioRef.current) {
					remoteAudioRef.current.srcObject = remoteStream;
					remoteAudioRef.current.style.display = "block";
				}
			});

			if (message.signal) {
				peer.signal(message.signal);
			}

			setPeerConnection(peer);
		} catch (error) {
			console.error("Error accessing media devices:", error);
			toast({
				title: "Error",
				description:
					"Failed to access microphone. Please check your permissions.",
				variant: "destructive",
			});
		}
	};

	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	const sendSignalingMessage = (message: any) => {
		if (socketCallRef.current?.readyState === WebSocket.OPEN) {
			socketCallRef.current.send(JSON.stringify(message));
		} else {
			console.error("WebSocket for call is not open");
		}
	};

	const handleIncomingCall = async (message: SignalMessage) => {
		console.log("Incoming call:", message);
		setPendingCallMessage(message);
		setIsAlertOpen(true);
	};

	const handleAcceptCall = async () => {
		setIsAlertOpen(false);
		if (pendingCallMessage) {
			try {
				await checkAndRequestPermissions(
					pendingCallMessage.type === "video-call",
				);
				await getMedia(
					pendingCallMessage,
					pendingCallMessage.type === "video-call",
				);
			} catch (error) {
				console.error("Error handling accept call:", error);
				toast({
					title: "Error",
					description: "Failed to start the call. Please try again.",
					variant: "destructive",
				});
			}
		}
		setPendingCallMessage(null);
	};

	const handleDeclineCall = () => {
		setIsAlertOpen(false);
		if (pendingCallMessage) {
			sendSignalingMessage({
				type: "decline-call",
				signal: null,
				to: pendingCallMessage.from,
			});
		}
		setPendingCallMessage(null);
	};

	const handleIncomingVideoCall = async (message: SignalMessage) => {
		setPendingCallMessage(message);
		setIsAlertOpen(true);
	};

	// useEffect(() => {
	// 	messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	// }, []);

	const sendMessageCallback = useCallback(async () => {
		if (!isWebSocketReady) {
			toast({
				title: "Error",
				description: "WebSocket connection is not ready. Please try again.",
				variant: "destructive",
			});
			return;
		}

		if (!newMessage.trim() && fileUploads.length === 0) {
			toast({
				title: "Error",
				description:
					"Message cannot be empty and must have at least one attachment.",
				variant: "destructive",
			});
			return;
		}

		const tomorrow = new Date(new Date().getTime() + 24 * 60 * 60 * 1000);
		const expiresAt = tomorrow.toISOString();

		try {
			console.log(partnerPublicKey);
			console.log(publicKey);
			console.log(newMessage);
			const {
				encryptedMessage,
				encryptedAESKeyReceiver,
				encryptedAESKeySender,
				encryptedFilesUploads,
			} = await encryptMessage(
				newMessage,
				partnerPublicKey,
				publicKey,
				fileUploads,
			);

			if (wsRef.current?.readyState === WebSocket.OPEN) {
				const messageToSend = JSON.stringify({
					type: "message",
					body: encryptedMessage,
					receiverId: Number(partnerId),
					aesKeySender: encryptedAESKeySender,
					aesKeyReceiver: encryptedAESKeyReceiver,
					expiredAt: expiresAt,
					fileAttachments: JSON.stringify(encryptedFilesUploads),
				});
				console.log("Message to send:", messageToSend);

				wsRef.current.send(messageToSend);

				const message: Message = {
					id: -1, // Temporary ID
					senderId: Number(userId),
					body: newMessage,
					state: "sent",
					receiverId: Number(partnerId),
					aesKeySender: encryptedAESKeySender,
					aesKeyReceiver: encryptedAESKeyReceiver,
					expiredAt: expiresAt,
					fileAttachments: fileUploads,
				};

				setMessages((prev) => [...prev, message]);
				setNewMessage("");
				setFileUploads([]);
			} else {
				throw new Error("WebSocket is not in OPEN state");
			}
		} catch (error) {
			console.error("Failed to send message:", error);
			toast({
				title: "Error",
				description: "Failed to send message. Please try again.",
				variant: "destructive",
			});
		}
	}, [
		newMessage,
		partnerId,
		partnerPublicKey,
		userId,
		isWebSocketReady,
		toast,
		publicKey,
		fileUploads,
	]);

	const sendMessage = (e: React.FormEvent) => {
		e.preventDefault();
		sendMessageCallback();
	};

	const handleFileUpload = async (
		event: React.ChangeEvent<HTMLInputElement>,
	) => {
		const files = Array.from(event.target.files || []);
		if (files.length === 0) return;

		const formData = new FormData();
		// biome-ignore lint/complexity/noForEach: <explanation>
		files.forEach((file) => formData.append("files", file));

		try {
			const response = await fetch("http://localhost:8000/api/upload-files", {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
				body: formData,
			});

			if (!response.ok) {
				throw new Error("File upload failed");
			}

			const result = await response.json();
			console.log("File upload result:", result);
			const { data, success } = FileUploadsSchema.safeParse(result);
			if (!success) {
				throw new Error("Failed to parse file uploads");
			}
			setFileUploads(data);
		} catch (error) {
			console.error("Error uploading files:", error);
			toast({
				title: "Error",
				description: "Failed to upload files. Please try again.",
				variant: "destructive",
			});
		}
	};

	return (
		<div className="flex flex-col h-screen p-4">
			<h1 className="text-2xl text-center font-bold mb-4">
				Chat of {nickname}
			</h1>
			<div className="flex-1 overflow-y-auto mb-4 space-y-2">
				{messages?.map((message) => (
					<div
						key={`${message.id} - ${message.body}`}
						className={`p-2 rounded-lg mx-auto bg-gray-200 max-w-md ${
							message.senderId === Number(userId)
								? "ml-auto bg-blue-200"
								: "mr-auto"
						}`}
					>
						<p>{`${
							message.senderId === Number(userId) ? "You" : "Partner"
						}: ${message.body}`}</p>
						<p className="text-xs text-gray-500">{message.state}</p>
						{message.fileAttachments?.map((file: FileUpload) => (
							<FileInfo key={file.fileName} fileInfo={file} />
						))}
					</div>
				))}
				<div ref={messagesEndRef} />
			</div>
			<AlertDialog open={isAlertOpen} onOpenChange={setIsAlertOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Incoming Call</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingCallMessage?.type === "video-call"
								? "Video call"
								: "Audio call"}{" "}
							incoming. Do you want to accept?
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={handleDeclineCall}>
							Decline
						</AlertDialogCancel>
						<AlertDialogAction onClick={handleAcceptCall}>
							Accept
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<div className="flex gap-2 justify-center mb-2">
				<Button onClick={() => startCall(false)}>Call</Button>
				<Button onClick={() => startCall(true)}>Video Call</Button>
				<Button onClick={endCall}>End Call</Button>
				{/* biome-ignore lint/a11y/useMediaCaption: <explanation> */}
				<audio ref={remoteAudioRef} autoPlay />
				{/* biome-ignore lint/a11y/useMediaCaption: <explanation> */}
				<video ref={remoteVideoRef} autoPlay style={{ display: "none" }} />
			</div>
			<form onSubmit={sendMessage} className="space-y-2">
				<div className="flex space-x-2">
					<Input
						type="file"
						onChange={handleFileUpload}
						className="flex-1"
						multiple={true}
					/>
					<Input
						type="text"
						value={partnerId}
						onChange={(e) => setPartnerId(e.target.value)}
						placeholder="Partner ID"
						className="flex-1"
					/>
				</div>
				<div className="flex space-x-2">
					<Input
						type="text"
						value={newMessage}
						onChange={(e) => setNewMessage(e.target.value)}
						placeholder="Type a message..."
						className="flex-1"
					/>
					<Button type="submit">Send</Button>
				</div>
				{fileUploads.length > 0 && (
					<div className="mt-2">
						<p>Attached files:</p>
						{fileUploads.map((file) => (
							<FileInfo key={file.fileName} fileInfo={file} />
						))}
					</div>
				)}
			</form>
		</div>
	);
}
