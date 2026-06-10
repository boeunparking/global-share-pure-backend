// 깃허브 액션 적용 완료 찐
// backend/server.js
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import mysql from "mysql2/promise"; // 1. MySQL 라이브러리 임포트
import uploadRouter from "./routes/upload.js";

dotenv.config();
const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

// 2. 데이터베이스 커넥션 풀(Pool) 설정
// .env 파일에 있는 환경변수를 읽어와서 AWS RDS와 연결합니다.
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// 3. 백엔드 서버가 켜질 때 RDS 연결이 잘 되는지 콘솔로 확인하는 로직
(async () => {
  try {
    const connection = await db.getConnection();
    console.log("✅ AWS RDS MySQL 데이터베이스 연결 성공!");
    connection.release(); // 테스트 후 연결 반환
  } catch (err) {
    console.error("❌ AWS RDS MySQL 연결 실패:", err.message);
    console.error(
      "💡 팁: RDS 보안그룹 인바운드 규칙에 백엔드 서버 IP/보안그룹이 열려있는지 확인하세요.",
    );
  }
})();

// 4. 회원가입 API 예시 (앞서 만든 users 테이블 구조 적용)
app.post("/api/register", async (req, res) => {
  const { email, password_hash, nickname } = req.body;

  if (!email || !password_hash || !nickname) {
    return res
      .status(400)
      .json({ error: "이메일, 비밀번호, 닉네임은 필수 항목입니다." });
  }

  try {
    const query = `INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)`;
    await db.query(query, [email, password_hash, nickname]);

    res.status(201).json({
      success: true,
      message: "회원가입이 성공적으로 완료되었습니다!",
    });
  } catch (error) {
    console.error("회원가입 에러:", error);

    if (error.errno === 1062) {
      return res.status(409).json({ error: "이미 가입된 이메일 주소입니다." });
    }

    res
      .status(500)
      .json({ error: "데이터베이스 저장 중 서버 에러가 발생했습니다." });
  }
});

// 5. 로그인 API
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res
      .status(400)
      .json({ error: "이메일과 비밀번호를 모두 입력해주세요." });
  }

  try {
    const query = `SELECT * FROM users WHERE email = ?`;
    const [rows] = await db.query(query, [email]);

    if (rows.length === 0) {
      return res
        .status(401)
        .json({ error: "가입되지 않은 이메일 주소입니다." });
    }

    const user = rows[0];

    if (user.password_hash !== password) {
      return res.status(401).json({ error: "비밀번호가 일치하지 않습니다." });
    }

    res.status(200).json({
      success: true,
      message: `${user.nickname}님, 환영합니다!`,
      user: {
        id: user.user_id, // 💡 중요: 용량 체크 시 구분을 위해 유저 식별용 ID를 프론트에 넘겨주는 것이 좋습니다.
        email: user.email,
        nickname: user.nickname,
      },
    });
  } catch (error) {
    console.error("로그인 에러:", error);
    res
      .status(500)
      .json({ error: "데이터베이스 조회 중 서버 에러가 발생했습니다." });
  }
});

// ==========================================
// [새로 추가] 6. 파일 용량 체크 및 기록 API (2번 + 3번 로직)
// ==========================================
app.post("/api/files/upload-success", async (req, res) => {
  const { userId, fileName, s3Url, fileSize } = req.body;

  // 필수 인자값 확인
  if (!userId || !fileName || !s3Url || !fileSize) {
    return res
      .status(400)
      .json({ error: "파일 기록에 필요한 필수 정보가 누락되었습니다." });
  }

  try {
    // 2번 로직: 해당 유저의 사용 가능한 남은 용량 조회 및 검증
    const verifyQuery = `
      SELECT 
        u.max_storage_size,
        IFNULL(SUM(f.file_size), 0) AS current_used_size,
        u.max_storage_size - IFNULL(SUM(f.file_size), 0) AS remaining_size
      FROM users u
      LEFT JOIN files f ON u.user_id = f.user_id
      WHERE u.user_id = ?
      GROUP BY u.user_id, u.max_storage_size;
    `;

    const [rows] = await db.query(verifyQuery, [userId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "존재하지 않는 유저입니다." });
    }

    const { remaining_size } = rows[0];

    // 남은 용량보다 새로 올릴 파일의 크기가 더 크다면 예외 처리
    if (fileSize > remaining_size) {
      return res.status(400).json({
        error: "개인 저장 공간이 부족하여 파일을 등록할 수 없습니다.",
        remainingSize: remaining_size,
      });
    }

    // 3번 로직: 용량 검증 통과 시 files 테이블에 파일 메타데이터 기록
    const insertQuery = `
      INSERT INTO files (user_id, file_name, s3_url, file_size) 
      VALUES (?, ?, ?, ?);
    `;
    await db.query(insertQuery, [userId, fileName, s3Url, fileSize]);

    res.status(200).json({
      success: true,
      message: "파일이 성공적으로 기록되었으며 용량이 반영되었습니다.",
    });
  } catch (error) {
    console.error("파일 업로드 기록 중 서버 에러:", error);
    res
      .status(500)
      .json({ error: "데이터베이스 처리 중 에러가 발생했습니다." });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// 📌 업로드가 성공하던 원래 구조 그대로 놔둡니다.
app.use("/", uploadRouter);

app.listen(PORT, () => {
  console.log(`🚀 백엔드 서버가 ${PORT}번 포트에서 가동 중입니다!`);
});
