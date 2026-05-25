# PetClinic AWS 배포 가이드 (콘솔 전용)

---

## 최종 아키텍처

```
사용자
  │ HTTPS
  ▼
CloudFront + WAF (cf-waf)
  ├── /*            → S3 (React 정적 파일)
  └── /petclinic/*  → ALB + WAF (alb-waf, 커스텀 헤더 검증)
                          │ [Public Subnet]
                          ▼
                     ECS WEB - nginx (Rolling)
                          │ [Private Subnet]
                          │ Service Connect (was:9966)
                          ▼
                     ECS WAS - Spring Boot (Rolling)
                          │ [Private Subnet]
                          ▼
                     RDS MySQL (petclinic-db)
                     [Private Subnet, KMS 암호화]

감사/관측:
  CloudTrail → S3 (petclinic-cloudtrail-*)  ← 모든 API 호출 기록
  CloudWatch → 로그(/ecs/*), 알람(CPU/5xx/RDS)
  Secrets Manager (aws/secretsmanager KMS) ← DB 자격증명
```

## CI/CD 파이프라인 구조

```
GitHub Push (master)
        │
        ▼
GitHub Actions (OIDC)
        ├── [Frontend] npm build → S3 sync → CF invalidation
        └── CodePipeline 트리거 (WAS, WEB)
                  │
       ┌──────────┴──────────┐
       ▼                     ▼
CodePipeline (WAS)    CodePipeline (WEB)
  ├── Source: GitHub    ├── Source: GitHub
  ├── Build: CodeBuild  ├── Build: CodeBuild
  └── Deploy: ECS       └── Deploy: ECS
       (Rolling)              (Rolling)
```

## 네트워크 구성

```
VPC 10.0.0.0/16
  ├── Public Subnet 2a  10.0.1.0/24  → IGW  (ALB)
  ├── Public Subnet 2c  10.0.2.0/24  → IGW  (ALB)
  ├── Private Subnet 2a 10.0.11.0/24 → NAT  (ECS WEB, WAS)
  └── Private Subnet 2c 10.0.12.0/24 → NAT  (ECS WEB, WAS, RDS)
```

---

## 사전 준비

- AWS 계정 로그인 완료
- GitHub 리포지토리 생성 및 코드 push 완료
- 리전 고정: **아시아 태평양(서울) ap-northeast-2**

---

## 1단계. VPC 생성

### 1-1. VPC 생성

1. 검색창 → `VPC` → **VPC** 클릭
2. 왼쪽 메뉴 **VPC** → **VPC 생성** 클릭
3. 설정:
   - 생성할 리소스: `VPC만`
   - 이름 태그: `petclinic-vpc`
   - IPv4 CIDR: `10.0.0.0/16`
4. **VPC 생성**

### 1-2. 서브넷 4개 생성

왼쪽 메뉴 **서브넷** → **서브넷 생성**

아래 4개를 순서대로 생성 (각각 **서브넷 추가** 버튼으로 한 화면에서 가능):

| 이름 | AZ | CIDR |
|------|-----|------|
| `petclinic-public-2a` | ap-northeast-2a | `10.0.1.0/24` |
| `petclinic-public-2c` | ap-northeast-2c | `10.0.2.0/24` |
| `petclinic-private-2a` | ap-northeast-2a | `10.0.11.0/24` |
| `petclinic-private-2c` | ap-northeast-2c | `10.0.12.0/24` |

> **가용 영역 선택 이유**: ap-northeast-2a, ap-northeast-2c를 사용합니다. 2b는 일부 인스턴스 타입이 제공되지 않을 수 있어 2a+2c 조합이 실무에서 더 안정적입니다.

- VPC: `petclinic-vpc` 선택
- **서브넷 생성**

### 1-3. 인터넷 게이트웨이(IGW) 생성 및 연결

1. 왼쪽 메뉴 **인터넷 게이트웨이** → **인터넷 게이트웨이 생성**
2. 이름: `petclinic-igw` → **생성**
3. 생성된 IGW 선택 → **작업** → **VPC에 연결**
4. `petclinic-vpc` 선택 → **연결**

### 1-4. NAT 게이트웨이 생성

> Public Subnet에 생성해야 합니다. Private Subnet의 ECS가 ECR, CloudWatch 등 외부와 통신하기 위해 필요합니다.

1. 왼쪽 메뉴 **NAT 게이트웨이** → **NAT 게이트웨이 생성**
2. 설정:
   - 이름: `petclinic-nat`
   - 서브넷: `petclinic-public-2a`
   - 연결 유형: `퍼블릭`
   - **탄력적 IP 할당** 클릭 (자동 생성)
3. **NAT 게이트웨이 생성**

> NAT GW 상태가 `Available`이 될 때까지 기다린 후 다음 진행 (2~3분)

### 1-5. 라우팅 테이블 생성

**Public 라우팅 테이블:**

1. 왼쪽 메뉴 **라우팅 테이블** → **라우팅 테이블 생성**
2. 이름: `petclinic-rt-public`, VPC: `petclinic-vpc` → **생성**
3. 생성된 테이블 클릭 → **라우팅** 탭 → **라우팅 편집**
4. **라우팅 추가**: 대상 `0.0.0.0/0`, 대상(Target) `인터넷 게이트웨이` → `petclinic-igw` → **저장**
5. **서브넷 연결** 탭 → **서브넷 연결 편집**
6. `petclinic-public-2a`, `petclinic-public-2c` 체크 → **저장**

**Private 라우팅 테이블:**

1. **라우팅 테이블 생성**
2. 이름: `petclinic-rt-private`, VPC: `petclinic-vpc` → **생성**
3. **라우팅** 탭 → **라우팅 편집**
4. **라우팅 추가**: 대상 `0.0.0.0/0`, 대상(Target) `NAT 게이트웨이` → `petclinic-nat` → **저장**
5. **서브넷 연결** 탭 → **서브넷 연결 편집**
6. `petclinic-private-2a`, `petclinic-private-2c` 체크 → **저장**

**✅ 1단계 완료 확인**
- VPC → `petclinic-vpc` 상태 `Available`
- 서브넷 4개 목록 확인: public-2a, public-2c, private-2a, private-2c
- 인터넷 게이트웨이 `petclinic-igw` → 상태 `Attached` (petclinic-vpc에 연결됨)
- NAT 게이트웨이 `petclinic-nat` → 상태 `Available`
- 라우팅 테이블 2개 확인: `petclinic-rt-public`(0.0.0.0/0 → IGW), `petclinic-rt-private`(0.0.0.0/0 → NAT)
- 각 라우팅 테이블 서브넷 연결: public에 2개, private에 2개

---

## 2단계. ECR 리포지토리 생성

1. 검색창 → `ECR` → **Elastic Container Registry**
2. **리포지토리 생성**:
   - 표시 여부: `프라이빗`
   - 이름: `petclinic-was` → **생성**
3. 동일하게:
   - 이름: `petclinic-web` → **생성**

### ECR 수명 주기 정책 (Lifecycle Policy)

> 오래된 이미지를 자동 삭제하여 스토리지 비용을 절감합니다. 커밋마다 이미지가 쌓이므로 주기적 정리 필수.

4. `petclinic-was` 리포지토리 클릭 → **수명 주기 정책** 탭 → **수명 주기 정책 편집**
5. 아래 JSON 붙여넣기:

```json
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "태그 없는 이미지 3일 후 삭제",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": 3
      },
      "action": {"type": "expire"}
    },
    {
      "rulePriority": 2,
      "description": "이미지 최대 10개 유지 (오래된 순 삭제)",
      "selection": {
        "tagStatus": "any",
        "countType": "imageCountMoreThan",
        "countNumber": 10
      },
      "action": {"type": "expire"}
    }
  ]
}
```

6. **저장** → `petclinic-web` 리포지토리에도 동일하게 적용

**✅ 2단계 완료 확인**
- ECR → 리포지토리 목록 → `petclinic-was`, `petclinic-web` 2개 존재
- 각 리포지토리 → **수명 주기 정책** 탭 → 규칙 2개 설정됨 (언태그 3일, 최대 10개)

---

## 3단계. IAM 역할 생성

> EC2 Launch Type은 EC2 인스턴스 자체의 역할(인스턴스 프로파일)과 컨테이너 레벨의 역할(Task Execution, Task)이 분리됩니다.
> 배스천 없이 EC2 접속은 SSM(인스턴스 프로파일), 컨테이너 직접 접속은 ECS Exec(Task Role)으로 처리합니다.

### 3-1. EC2 컨테이너 인스턴스 역할 (ECS EC2 인스턴스에 부여)

> ECS Agent가 컨트롤 플레인과 통신하고, ECR 이미지를 Pull하며, CloudWatch로 로그를 전송합니다.
> SSM으로 배스천 없이 콘솔에서 EC2 인스턴스에 직접 접속합니다.

1. IAM → **역할** → **역할 생성**
2. 신뢰할 수 있는 엔터티: `AWS 서비스` → 서비스: `EC2` → **다음**
3. 아래 정책 2개 검색 후 체크:
   - `AmazonEC2ContainerServiceforEC2Role` (ECS Agent 통신 + ECR Pull + CloudWatch 로그)
   - `AmazonSSMManagedInstanceCore` (SSM 콘솔 접속 + 명령 실행)
4. **다음** → 역할 이름: `petclinic-ec2-instance-role` → **역할 생성**

### 3-3. ECS Task Execution Role (에이전트가 컨테이너 밖에서 사용하는 권한)

> ECS Agent가 ECR 이미지 pull, CloudWatch 로그 전송, Secrets 주입에 사용

1. 검색창 → `IAM` → **역할** → **역할 생성**
2. 신뢰할 수 있는 엔터티: `AWS 서비스` → 서비스: `Elastic Container Service`
3. 사용 사례: `Elastic Container Service Task` → **다음**
4. `AmazonECSTaskExecutionRolePolicy` 검색 후 체크 → **다음**
5. 역할 이름: `petclinic-ecs-execution-role` → **역할 생성**
6. 생성된 역할 클릭 → **권한** 탭 → **권한 추가** → **인라인 정책 생성** → **JSON**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SecretsManager",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "*"
    },
    {
      "Sid": "KMS",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "*"
    }
  ]
}
```

7. 정책 이름: `petclinic-ecs-execution-addpolicy` → **정책 생성**

### 3-4. ECS Task Role (컨테이너 안 애플리케이션 코드가 사용하는 권한)

> 현재는 ECS Exec(배스천 대체 접속)용 권한만 부여. 추후 S3/SQS 등 필요 시 여기에 추가

1. **역할 생성** → `AWS 서비스` → `Elastic Container Service Task` → **다음**
2. 정책 추가 없이 **다음**
3. 역할 이름: `petclinic-ecs-task-role` → **역할 생성**
4. 생성된 역할 → **인라인 정책 생성** → **JSON**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ECSExec",
      "Effect": "Allow",
      "Action": [
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel"
      ],
      "Resource": "*"
    }
  ]
}
```

5. 정책 이름: `petclinic-ecs-task-addpolicy` → **정책 생성**

### 3-5. CodeBuild Role

1. **역할 생성** → `AWS 서비스` → `CodeBuild` → **다음**
2. 아래 정책 2개 검색 후 체크:
   - `AmazonEC2ContainerRegistryPowerUser`
   - `CloudWatchLogsFullAccess`
3. **다음** → 역할 이름: `petclinic-codebuild-role` → **역할 생성**
4. 생성된 역할 → **인라인 정책 생성** → **JSON**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3Artifacts",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:GetObjectVersion",
        "s3:GetBucketAcl",
        "s3:GetBucketLocation"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ECSDescribe",
      "Effect": "Allow",
      "Action": "ecs:DescribeTaskDefinition",
      "Resource": "*"
    },
    {
      "Sid": "STS",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    },
    {
      "Sid": "SecretsManagerRead",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ],
      "Resource": "*"
    }
  ]
}
```

5. 정책 이름: `petclinic-codebuild-addpolicy` → **정책 생성**

### 3-6. CodePipeline Role

1. **역할 생성** → `AWS 서비스` → `CodePipeline` → **다음**
2. 아래 정책 체크:
   - `AWSCodePipelineFullAccess`
   - `AWSCodeBuildAdminAccess`
   - `AmazonS3FullAccess`
   - `AmazonECS_FullAccess`
   - `AmazonEC2ContainerRegistryReadOnly`
3. **다음** → 역할 이름: `petclinic-codepipeline-role` → **역할 생성**

### 3-7. GitHub Actions Role (OIDC)

**OIDC Provider 등록:**

1. IAM → **자격 증명 공급자** → **공급자 추가**
2. 설정:
   - 공급자 유형: `OpenID Connect`
   - 공급자 URL: `https://token.actions.githubusercontent.com`
   - **지문 가져오기** 클릭
   - 대상: `sts.amazonaws.com`
3. **공급자 추가**

**Role 생성:**

4. **역할 생성** → `웹 자격 증명`
5. 자격 증명 공급자: `token.actions.githubusercontent.com`, 대상: `sts.amazonaws.com`
6. **다음** → 정책 추가 없이 **다음** → 역할 이름: `petclinic-github-actions-role` → **역할 생성**

**Trust Policy 수정:**

7. 역할 클릭 → **신뢰 관계** 탭 → **신뢰 정책 편집**
8. 아래 내용으로 교체 (`<ACCOUNT_ID>`, `<GITHUB_USERNAME>`, `<REPO_NAME>` 실제 값으로):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:<GITHUB_USERNAME>/<REPO_NAME>:*"
        }
      }
    }
  ]
}
```

9. **정책 업데이트**

**Permission Policy 추가:**

10. **권한** 탭 → **인라인 정책 생성** → **JSON**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CodePipelineTrigger",
      "Effect": "Allow",
      "Action": "codepipeline:StartPipelineExecution",
      "Resource": "*"
    },
    {
      "Sid": "S3Frontend",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudFrontInvalidation",
      "Effect": "Allow",
      "Action": "cloudfront:CreateInvalidation",
      "Resource": "*"
    }
  ]
}
```

11. 정책 이름: `petclinic-github-actions-policy` → **정책 생성**
12. 역할 ARN 메모: `arn:aws:iam::<ACCOUNT_ID>:role/petclinic-github-actions-role`

**✅ 3단계 완료 확인**
- IAM → 역할 검색창에 `petclinic` 입력 → 아래 6개 역할 모두 존재:
  `petclinic-ec2-instance-role` / `petclinic-ecs-execution-role` / `petclinic-ecs-task-role` / `petclinic-codebuild-role` / `petclinic-codepipeline-role` / `petclinic-github-actions-role`
- IAM → **자격 증명 공급자** → `token.actions.githubusercontent.com` 존재
- `petclinic-ecs-execution-role` → 권한 탭 → `AmazonECSTaskExecutionRolePolicy` + `petclinic-ecs-execution-addpolicy` 2개 확인
- `petclinic-github-actions-role` → 신뢰 관계 탭 → `repo:<GITHUB_USERNAME>/<REPO_NAME>:*` 조건 확인

---

## 4단계. S3 버킷 생성

### 4-1. 프론트엔드 버킷

1. 검색창 → `S3` → **버킷 만들기**
2. 설정:
   - 이름: `petclinic-frontend-<임의숫자>` (전 세계 고유)
   - 리전: `ap-northeast-2`
   - 퍼블릭 액세스 차단: **모두 체크 유지** (CloudFront OAC 사용)
3. **버킷 만들기** → 이름 메모

### 4-2. 파이프라인 아티팩트 버킷

1. **버킷 만들기**:
   - 이름: `petclinic-artifacts-<임의숫자>`
   - 리전: `ap-northeast-2`
2. **버킷 만들기** → 이름 메모

**✅ 4단계 완료 확인**
- S3 → `petclinic-frontend-<숫자>`, `petclinic-artifacts-<숫자>` 버킷 2개 존재
- 각 버킷 → 권한 탭 → 퍼블릭 액세스 차단 **모두 활성화** 확인
- 리전 모두 `ap-northeast-2` 확인

---

## 5단계. 보안 그룹 생성 (최소 권한)

> RDS, EC2, WEB, WAS, ALB 순으로 의존 방향에 맞게 생성합니다.

> 검색창 → `VPC` → 왼쪽 메뉴 **보안 그룹**

모든 보안 그룹에서 VPC는 `petclinic-vpc` 선택

### ALB 보안 그룹

1. **보안 그룹 생성**:
   - 이름: `petclinic-alb-sg`
   - 인바운드: `HTTPS(443)` 소스 `0.0.0.0/0`
   - 인바운드: `HTTP(80)` 소스 `0.0.0.0/0`
2. **생성**

### WEB 보안 그룹

3. **보안 그룹 생성**:
   - 이름: `petclinic-web-sg`
   - 인바운드: `TCP 80` 소스 → `petclinic-alb-sg` (ALB에서만)
4. **생성**

### WAS 보안 그룹

5. **보안 그룹 생성**:
   - 이름: `petclinic-was-sg`
   - 인바운드: `TCP 9966` 소스 → `petclinic-web-sg` (WEB에서만)
6. **생성**

### EC2 인스턴스 보안 그룹

> ECS EC2 인스턴스에 직접 부여되는 보안 그룹입니다. ECS가 동적으로 포트를 매핑하므로 ALB → 인스턴스 간 트래픽도 허용해야 합니다.

7. **보안 그룹 생성**:
   - 이름: `petclinic-ec2-sg`
   - 인바운드:
     - `TCP 80` 소스 → `petclinic-alb-sg` (WEB 컨테이너 고정 포트)
     - `TCP 32768-65535` 소스 → `petclinic-alb-sg` (ECS 동적 포트 매핑 범위)
     - `TCP 9966` 소스 → `petclinic-ec2-sg` (인스턴스 내 Service Connect 내부 통신)
8. **생성**

> **참고**: EC2 인스턴스 SSH 접속은 배스천 없이 SSM으로 처리하므로 22번 포트 인바운드는 불필요합니다.

### RDS 보안 그룹

9. **보안 그룹 생성**:
   - 이름: `petclinic-rds-sg`
   - 인바운드: `TCP 3306` 소스 → `petclinic-was-sg` (WAS에서만 DB 접근)
10. **생성**

**✅ 5단계 완료 확인**
- VPC → 보안 그룹 → 검색창 `petclinic` → 5개 보안 그룹 확인: `alb-sg`, `web-sg`, `was-sg`, `ec2-sg`, `rds-sg`
- `petclinic-ec2-sg` 인바운드 규칙 3개: TCP 80(alb-sg), TCP 32768-65535(alb-sg), TCP 9966(ec2-sg)
- `petclinic-rds-sg` 인바운드: TCP 3306 소스가 `petclinic-was-sg` (ID 확인, 이름 아님)
- 모든 보안 그룹 VPC가 `petclinic-vpc`

---

## 6단계. Secrets Manager 설정

> DB 자격증명 등 민감 정보를 코드/환경변수에 평문으로 두지 않고 Secrets Manager에 보관합니다.
> AWS 관리형 KMS(`aws/secretsmanager`)로 자동 암호화되며, 별도 KMS 키 생성 없이 사용 가능합니다.

> **저장 항목**: ECS Task Definition이 주입하는 값만 Secrets Manager에 보관합니다.
> - `username` + `password` → ECS `secrets` 필드로 컨테이너에 직접 주입
> - `host` (RDS 엔드포인트) → RDS 생성 후 추가 (7단계 완료 후)
> - dbname(petclinic), port(3306)은 상수값이므로 DATASOURCE_URL에 하드코딩, 시크릿 불필요

1. 검색창 → `Secrets Manager` → **새 보안 암호 저장**
2. 암호 유형: `다른 유형의 암호 (예: API 키)`
3. 키/값 탭에서 아래 2개 추가:

   | 키 | 값 |
   |----|----|
   | `username` | `petclinic_admin` |
   | `password` | 안전한 비밀번호 직접 입력 (영문+숫자+특수문자 12자 이상) |

4. **암호화 키**: `aws/secretsmanager` (기본값, AWS 관리형 KMS) 확인 후 **다음**
5. 보안 암호 이름: `petclinic/db-credentials`
6. 설명: `PetClinic RDS MySQL 접속 정보`
7. **다음** → **다음** → **저장**
8. 저장된 암호 클릭 → **보안 암호 ARN** 메모
   - 형식: `arn:aws:secretsmanager:ap-northeast-2:<ACCOUNT_ID>:secret:petclinic/db-credentials-xxxxxx`

**✅ 6단계 완료 확인**
- Secrets Manager → `petclinic/db-credentials` 보안 암호 존재
- **보안 암호 값 검색** 클릭 → `username`, `password` 2개 키 확인 (host는 7단계 후 추가)
- 암호화 키: `aws/secretsmanager` 확인
- 보안 암호 ARN 메모 완료 (11단계 Task Definition에서 사용)

---

## 7단계. RDS 생성

> Private Subnet에 배치하여 인터넷에 직접 노출되지 않습니다.
> AWS 관리형 KMS(`aws/rds`)로 저장 데이터를 자동 암호화합니다.

### 7-1. DB 서브넷 그룹 생성

> **별도 DB 서브넷 불필요**: ECS용 Private 서브넷(2a, 2c)을 RDS도 함께 사용합니다.
> DB 서브넷 그룹은 "어떤 서브넷에 RDS를 배치할 수 있는지" 알려주는 설정일 뿐, 새 서브넷을 만드는 것이 아닙니다.
> **Multi-AZ 조건**: 2개 이상의 AZ에 서브넷이 있으면 충분 — private-2a + private-2c로 충족됩니다.

1. 검색창 → `RDS` → 왼쪽 메뉴 **서브넷 그룹** → **DB 서브넷 그룹 생성**
2. 설정:
   - 이름: `petclinic-db-subnet-group`
   - 설명: `PetClinic RDS Private Subnets`
   - VPC: `petclinic-vpc`
3. **가용 영역 추가**: `ap-northeast-2a`, `ap-northeast-2c` 선택
4. **서브넷 추가**: `petclinic-private-2a` (10.0.11.0/24), `petclinic-private-2c` (10.0.12.0/24) 선택
5. **생성**

### 7-2. RDS 인스턴스 생성

1. RDS → **데이터베이스** → **데이터베이스 생성**
2. **엔진 옵션**:
   - 엔진 유형: `MySQL`
   - 엔진 버전: `MySQL 8.0` (최신 마이너 버전)
3. **템플릿**: `개발/테스트`
4. **설정**:
   - DB 인스턴스 식별자: `petclinic-db`
   - 마스터 사용자 이름: `petclinic_admin`
   - 마스터 암호: **Secrets Manager에서 관리** 선택
     - `petclinic/db-credentials` 선택
5. **인스턴스 구성**:
   - DB 인스턴스 클래스: `버스터블 클래스` → `db.t3.micro`
6. **스토리지**:
   - 스토리지 유형: `범용 SSD(gp3)`
   - 할당된 스토리지: `20` GiB
   - **스토리지 암호화**: 활성화
   - AWS KMS 키: `aws/rds` (AWS 관리형, 기본값)
7. **연결**:
   - VPC: `petclinic-vpc`
   - DB 서브넷 그룹: `petclinic-db-subnet-group`
   - 퍼블릭 액세스: `아니요`
   - VPC 보안 그룹: `petclinic-rds-sg` (기존 보안 그룹 제거 후 선택)
   - 가용 영역: `ap-northeast-2a`
8. **추가 구성**:
   - 초기 데이터베이스 이름: `petclinic`
   - 자동 백업: 활성화 (보존 기간 7일)
   - 로그 내보내기: `오류 로그`, `일반 로그`, `슬로우 쿼리 로그` 체크
9. **데이터베이스 생성** 클릭

> 생성 완료까지 약 5~10분 소요. 완료 후 **엔드포인트** 메모
> 형식: `petclinic-db.xxxxxxxxxx.ap-northeast-2.rds.amazonaws.com`

### 7-3. Secrets Manager에 RDS 엔드포인트 추가

10. Secrets Manager → `petclinic/db-credentials` → **보안 암호 값 검색** → **편집**
11. 키 추가:
    - 키: `host` / 값: 위에서 메모한 RDS 엔드포인트 (`petclinic-db.xxxxxxxxxx.ap-northeast-2.rds.amazonaws.com`)
12. **저장**

> 이제 Secrets Manager에 총 3개 키가 저장됩니다: `username`, `password`, `host`
> `host` 값은 11단계 Task Definition의 `SPRING_DATASOURCE_URL` 환경변수에도 직접 입력합니다.

> **DB 스키마 자동 초기화**: WAS 컨테이너가 처음 시작되면 Spring Boot가 `initDB.sql`(테이블 생성) → `populateDB.sql`(샘플 데이터 삽입)을 자동 실행합니다. 수동 명령 불필요.

**✅ 7단계 완료 확인**
- RDS → 데이터베이스 → `petclinic-db` 상태 `사용 가능` (생성 후 5~10분 소요)
- `petclinic-db` 클릭 → 연결 → 퍼블릭 액세스 `아니요`, 보안 그룹 `petclinic-rds-sg` 확인
- 엔드포인트 메모 완료 (`petclinic-db.xxxxxxxxxx.ap-northeast-2.rds.amazonaws.com`)
- 스토리지 → 암호화: 활성화됨, KMS 키: `aws/rds` 확인
- Secrets Manager → `petclinic/db-credentials` → 보안 암호 값 검색 → `username`, `password`, `host` 3개 키 확인

---

## 8단계. ALB 및 대상 그룹 생성

> 검색창 → `EC2` → 왼쪽 메뉴 **대상 그룹**

### 대상 그룹 생성

1. **대상 그룹 생성**:
   - 대상 유형: `IP 주소`
   - 이름: `petclinic-web-tg`
   - 프로토콜: `HTTP`, 포트: `80`
   - VPC: `petclinic-vpc`
   - 상태 확인 경로: `/health`
2. **다음** → 대상 등록 없이 **대상 그룹 생성**

### ALB 생성

3. 왼쪽 메뉴 **로드 밸런서** → **로드 밸런서 생성** → `Application Load Balancer` → **생성**
4. 설정:
   - 이름: `petclinic-alb`
   - 체계: `인터넷 경계`
   - VPC: `petclinic-vpc`
   - 가용 영역: `petclinic-public-2a`, `petclinic-public-2c` 모두 체크
   - 보안 그룹: `petclinic-alb-sg` (기본 보안 그룹 제거)
   - 리스너 HTTP:80 → 대상 그룹: `petclinic-web-tg`
5. **로드 밸런서 생성** → ALB DNS 이름 메모

**✅ 8단계 완료 확인**
- EC2 → 대상 그룹 → `petclinic-web-tg` 존재, 대상 유형 `IP`, 상태 확인 경로 `/health`
- EC2 → 로드 밸런서 → `petclinic-alb` 상태 `Active`
- `petclinic-alb` → 리스너 탭 → HTTP:80 → 대상 그룹 `petclinic-web-tg` 연결됨
- `petclinic-alb` → 가용 영역: ap-northeast-2a, ap-northeast-2c 2개 확인
- ALB DNS 이름 메모 완료 (`petclinic-alb-xxx.ap-northeast-2.elb.amazonaws.com`)

---

## 9단계. ECS 클러스터 생성 (EC2 Launch Type)

> **AMI를 직접 만들지 않습니다**: ECS EC2 Launch Type은 AWS가 제공하는 ECS 최적화 Amazon Linux 2023 AMI를 자동 사용합니다.
> 애플리케이션 코드는 Dockerfile로 빌드한 Docker 이미지(ECR 저장)로 배포됩니다. EC2 AMI에 앱을 굽는 방식이 아닙니다.
> EC2 인스턴스는 ECS Agent만 실행하고, 실제 앱은 컨테이너(Task)로 올라옵니다.

1. 검색창 → `ECS` → **클러스터** → **클러스터 생성**
2. 설정:
   - 이름: `petclinic-cluster`
   - 인프라: `Amazon EC2 인스턴스` 체크 (Fargate 체크 해제)
3. **EC2 인스턴스 설정**:
   - 프로비저닝 모델: `온디맨드`
   - EC2 인스턴스 유형: `t3.medium`
   - 원하는 용량: 최솟값 `1`, 최댓값 `4`
   - AMI ID: 비워두기 (자동으로 ECS 최적화 Amazon Linux 2023 선택)
   - 루트 볼륨 크기: `30` GiB
4. **네트워킹**:
   - VPC: `petclinic-vpc`
   - 서브넷: `petclinic-private-2a`, `petclinic-private-2c` 모두 선택
   - 보안 그룹: `petclinic-ec2-sg` (아직 없으면 5단계 보안 그룹 섹션 참고)
   - 퍼블릭 IP 자동 할당: **비활성화**
5. **인스턴스 역할**: `petclinic-ec2-instance-role` (3-1단계에서 생성)
6. **생성**

**Container Insights 활성화:**

7. `petclinic-cluster` 클릭 → **모니터링** 탭 → **Container Insights 관리** → `활성화` → **확인**

**✅ 9단계 완료 확인**
- ECS → 클러스터 → `petclinic-cluster` 상태 `Active`
- `petclinic-cluster` → **ECS 인스턴스** 탭 → `t3.medium` 인스턴스 1개 `ACTIVE` 상태
- EC2 → 인스턴스 → ECS가 자동 시작한 인스턴스 존재 (이름 태그: `ECS Instance - petclinic-cluster`)
- 해당 EC2 인스턴스 → IAM 역할: `petclinic-ec2-instance-role` 확인
- `petclinic-cluster` → 모니터링 탭 → Container Insights: `활성화됨`

---

## 10단계. CloudWatch 로그 그룹 및 알람 생성

### 로그 그룹

1. 검색창 → `CloudWatch` → 왼쪽 메뉴 **로그 그룹** → **로그 그룹 생성**
2. 이름: `/ecs/petclinic-was` → **생성**
3. 이름: `/ecs/petclinic-web` → **생성**

### CloudWatch 알람 (기본 4개)

> **경보** → **경보 생성** 으로 각각 생성합니다.

**① WAS CPU 사용률**
4. 지표 선택: `ECS` → `ClusterName, ServiceName` → `petclinic-cluster / petclinic-was-svc / CPUUtilization`
5. 조건: `80%` 초과 / 기간: `5분`
6. 알람 이름: `petclinic-was-cpu-high`

**② WEB CPU 사용률**
7. 동일하게 `petclinic-web-svc / CPUUtilization` 선택
8. 알람 이름: `petclinic-web-cpu-high`

**③ ALB 5xx 에러**
9. 지표 선택: `ApplicationELB` → `LoadBalancer` → `petclinic-alb / HTTPCode_Target_5XX_Count`
10. 조건: `10` 초과 / 기간: `5분`
11. 알람 이름: `petclinic-alb-5xx-high`

**④ RDS CPU 사용률**
12. 지표 선택: `RDS` → `DBInstanceIdentifier` → `petclinic-db / CPUUtilization`
13. 조건: `80%` 초과 / 기간: `5분`
14. 알람 이름: `petclinic-rds-cpu-high`

### CloudWatch 대시보드

> 주요 지표를 한 화면에서 모니터링합니다. 장애 대응 시 바로 열어보는 뷰.

15. CloudWatch → 왼쪽 메뉴 **대시보드** → **대시보드 생성**
16. 이름: `petclinic-dashboard` → **생성**
17. **위젯 추가** → **선 그래프**로 아래 지표 순서대로 추가:

| 위젯 이름 | 네임스페이스 | 지표 | 차원 |
|----------|------------|------|------|
| WAS CPU | ECS | CPUUtilization | Cluster=petclinic-cluster, Service=petclinic-was-svc |
| WEB CPU | ECS | CPUUtilization | Cluster=petclinic-cluster, Service=petclinic-web-svc |
| ALB 요청 수 | ApplicationELB | RequestCount | LoadBalancer=petclinic-alb |
| ALB 5xx | ApplicationELB | HTTPCode_Target_5XX_Count | LoadBalancer=petclinic-alb |
| RDS CPU | RDS | CPUUtilization | DBInstanceIdentifier=petclinic-db |

18. **숫자(Number)** 위젯으로 추가:

| 위젯 이름 | 지표 |
|----------|------|
| WAS 실행 태스크 수 | ECS / petclinic-was-svc / RunningTaskCount |
| WEB 실행 태스크 수 | ECS / petclinic-web-svc / RunningTaskCount |

19. **대시보드 저장**

**✅ 10단계 완료 확인**
- CloudWatch → 로그 그룹 → `/ecs/petclinic-was`, `/ecs/petclinic-web` 2개 존재
- CloudWatch → 경보 → `petclinic-*` 검색 → 4개 경보 존재 (상태 `데이터 부족`은 정상)
- CloudWatch → 대시보드 → `petclinic-dashboard` 존재 → 클릭 시 위젯 표시 확인

---

## 11단계. ECS Task Definition 생성

### 11-1. WAS Task Definition

> Secrets Manager에서 DB 자격증명을 런타임에 주입합니다. `<ACCOUNT_ID>`와 `<SECRET_ARN>` 을 실제 값으로 교체하세요.
> `<SECRET_ARN>` = 6단계에서 메모한 ARN (예: `arn:aws:secretsmanager:ap-northeast-2:<ACCOUNT_ID>:secret:petclinic/db-credentials-xxxxxx`)

1. ECS → **태스크 정의** → **새 태스크 정의 생성** → **JSON로 구성** 탭
2. 아래 내용 붙여넣기:

```json
{
  "family": "petclinic-was",
  "networkMode": "awsvpc",
  "executionRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/petclinic-ecs-execution-role",
  "taskRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/petclinic-ecs-task-role",
  "requiresCompatibilities": ["EC2"],
  "cpu": "512",
  "memory": "1024",
  "containerDefinitions": [
    {
      "name": "petclinic-was",
      "image": "<ACCOUNT_ID>.dkr.ecr.ap-northeast-2.amazonaws.com/petclinic-was:latest",
      "portMappings": [
        {
          "name": "was",
          "containerPort": 9966,
          "protocol": "tcp",
          "appProtocol": "http"
        }
      ],
      "environment": [
        {
          "name": "SPRING_PROFILES_ACTIVE",
          "value": "mysql,spring-data-jpa"
        },
        {
          "name": "SPRING_DATASOURCE_URL",
          "value": "jdbc:mysql://petclinic-db.xxxxxxxxxx.ap-northeast-2.rds.amazonaws.com:3306/petclinic?useSSL=true&serverTimezone=Asia/Seoul"
        }
      ],
      "secrets": [
        {
          "name": "SPRING_DATASOURCE_USERNAME",
          "valueFrom": "<SECRET_ARN>:username::"
        },
        {
          "name": "SPRING_DATASOURCE_PASSWORD",
          "valueFrom": "<SECRET_ARN>:password::"
        }
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -sf http://localhost:9966/petclinic/api/vets > /dev/null || exit 1"],
        "interval": 30,
        "timeout": 10,
        "retries": 3,
        "startPeriod": 60
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/petclinic-was",
          "awslogs-region": "ap-northeast-2",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

> **secrets 필드 동작**: ECS Agent가 컨테이너 시작 전 Secrets Manager에서 값을 읽어 환경변수로 주입합니다. 컨테이너 내부 코드는 일반 환경변수처럼 사용하며, 실제 값은 CloudWatch 로그에 노출되지 않습니다.

> **healthCheck 주의**: `curl`이 컨테이너 이미지에 없으면 헬스체크가 실패합니다. Dockerfile에 `RUN apt-get install -y curl` (또는 `yum install -y curl`)을 추가하거나, `wget -q -O /dev/null http://localhost:9966/petclinic/api/vets`로 교체하세요. `startPeriod: 60`은 JVM 기동 + DB 연결 초기화 시간을 고려한 유예 기간입니다.

3. **생성**

### 11-2. WEB Task Definition

1. **새 태스크 정의 생성** → **JSON로 구성** (`<ACCOUNT_ID>` 교체):

```json
{
  "family": "petclinic-web",
  "networkMode": "awsvpc",
  "executionRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/petclinic-ecs-execution-role",
  "taskRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/petclinic-ecs-task-role",
  "requiresCompatibilities": ["EC2"],
  "cpu": "256",
  "memory": "512",
  "containerDefinitions": [
    {
      "name": "petclinic-web",
      "image": "<ACCOUNT_ID>.dkr.ecr.ap-northeast-2.amazonaws.com/petclinic-web:latest",
      "portMappings": [
        {
          "name": "petclinic-web",
          "containerPort": 80,
          "protocol": "tcp"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/petclinic-web",
          "awslogs-region": "ap-northeast-2",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

2. **생성**

**✅ 11단계 완료 확인**
- ECS → 태스크 정의 → `petclinic-was`, `petclinic-web` 각각 리비전 1 이상 존재
- `petclinic-was` 최신 리비전 클릭 → **JSON** 탭 → `secrets` 필드에 `SPRING_DATASOURCE_USERNAME`, `SPRING_DATASOURCE_PASSWORD` 확인
- `SPRING_DATASOURCE_URL` 값의 RDS 엔드포인트가 7단계 메모 값과 일치하는지 확인
- `healthCheck.startPeriod` = 60 확인

---

## 12단계. ECS Service 생성

### 12-1. WAS Service

1. ECS → `petclinic-cluster` → **서비스** 탭 → **생성**
2. 설정:
   - 시작 유형: `EC2`
   - 태스크 정의: `petclinic-was` (최신 버전)
   - 서비스 이름: `petclinic-was-svc`
   - 원하는 태스크: `1`
   - **명령 실행 사용**: **체크** (ECS Exec 활성화 — 배스천 없이 컨테이너 내부 접속용)
3. **네트워킹**:
   - VPC: `petclinic-vpc`
   - 서브넷: `petclinic-private-2a`, `petclinic-private-2c`
   - 보안 그룹: `petclinic-was-sg`
4. **Service Connect**:
   - 켜기: **활성화**
   - 유형: `클라이언트 및 서버`
   - **새 네임스페이스 생성**: `petclinic-ns`
   - 포트 이름: `was`, 검색 이름: `was`, 포트: `9966`
5. **생성**

### 12-2. WEB Service

1. **서비스 생성**:
   - 시작 유형: `EC2`
   - 태스크 정의: `petclinic-web` (최신 버전)
   - 서비스 이름: `petclinic-web-svc`
   - 원하는 태스크: `1`
   - 배포 유형: `롤링 업데이트`
2. **네트워킹**:
   - VPC: `petclinic-vpc`
   - 서브넷: `petclinic-private-2a`, `petclinic-private-2c`
   - 보안 그룹: `petclinic-web-sg`
3. **로드 밸런싱**:
   - 로드 밸런서: `petclinic-alb`
   - 컨테이너: `petclinic-web 80:80`
   - 리스너: `80 HTTP`
   - 대상 그룹: `petclinic-web-tg`
4. **Service Connect**:
   - 켜기: **활성화**
   - 유형: `클라이언트만`
   - 네임스페이스: `petclinic-ns`
5. **생성**

### 12-3. ECS Service Auto Scaling 설정

> ECS 서비스 수준의 태스크 수 자동 조정입니다.
> **동작 순서**: CPU 70% 초과 감지 → 태스크 수 증가 시도 → EC2 용량 부족 시 클러스터 ASG가 인스턴스 추가 → 신규 태스크 배치
> 9단계 클러스터 생성 시 설정한 ASG(최솟값 1, 최댓값 4)가 기반이 되며, Capacity Provider가 자동으로 연동됩니다.

**WAS 서비스 Auto Scaling:**

1. ECS → `petclinic-cluster` → **서비스** 탭 → `petclinic-was-svc` 클릭 → **업데이트**
2. **서비스 Auto Scaling** 섹션 찾기:
   - **서비스 Auto Scaling 사용** 체크
   - 원하는 최솟값: `1`
   - 원하는 최댓값: `4`
3. **정책 추가**:
   - 조정 유형: `대상 추적`
   - 정책 이름: `petclinic-was-cpu-scaling`
   - ECS 서비스 지표: `ECSServiceAverageCPUUtilization`
   - 대상 값: `70`
   - 스케일 아웃 쿨다운: `60`초
   - 스케일 인 쿨다운: `300`초
4. **업데이트**

**WEB 서비스 Auto Scaling:**

5. `petclinic-web-svc` 클릭 → **업데이트**
6. **서비스 Auto Scaling** 섹션:
   - 최솟값: `1`, 최댓값: `4`
   - 정책 이름: `petclinic-web-cpu-scaling`
   - 지표/대상값/쿨다운: WAS와 동일
7. **업데이트**

**✅ 12단계 완료 확인**
- ECS → `petclinic-cluster` → 서비스 탭 → `petclinic-was-svc`, `petclinic-web-svc` 2개 상태 `Active`
- 각 서비스 → **태스크** 탭 → 태스크 1개 상태 `RUNNING` (시작 2~3분 소요, 헬스체크 통과 후)
- `petclinic-was-svc` → **구성** 탭 → Service Connect 네임스페이스 `petclinic-ns`, 유형 `서버`
- `petclinic-web-svc` → 로드 밸런서 `petclinic-alb`, 대상 그룹 `petclinic-web-tg` 연결됨
- EC2 → 대상 그룹 → `petclinic-web-tg` → 대상 탭 → IP 주소 1개, 상태 `healthy`
- 각 서비스 → **Auto Scaling** 탭 → 정책 1개 확인

---

## 13단계. CodeBuild 프로젝트 생성

> 검색창 → `CodeBuild` → **빌드 프로젝트 생성**

### 13-1. WAS 빌드 프로젝트

1. 프로젝트 이름: `petclinic-was-build`
2. **소스**:
   - 소스 공급자: `GitHub`
   - **GitHub에 연결** → GitHub 계정 연결 (최초 1회)
   - 리포지토리: 본인 리포지토리 선택
3. **환경**:
   - 환경 이미지: `관리형 이미지`
   - 컴퓨팅: `EC2`
   - 운영 체제: `Amazon Linux`
   - 런타임: `Standard`, 이미지: `aws/codebuild/standard:7.0`
   - 권한 있음: **체크** (Docker 빌드 필수)
   - 서비스 역할: `기존 서비스 역할` → `petclinic-codebuild-role`
4. **Buildspec**:
   - `buildspec 파일 사용`
   - 이름: `spring-petclinic-reactjs/buildspec.yml`
5. **아티팩트**:
   - 유형: `Amazon S3`
   - 버킷: `petclinic-artifacts-<숫자>`
   - 이름: `was-build`
   - 패키징: `Zip`
6. **생성**

### 13-2. WEB 빌드 프로젝트

1. 프로젝트 이름: `petclinic-web-build`
2. 소스/환경: 동일
3. **Buildspec** 이름: `spring-petclinic-reactjs/web/buildspec.yml`
4. **아티팩트** 이름: `web-build`
5. **생성**

**✅ 13단계 완료 확인**
- CodeBuild → 빌드 프로젝트 → `petclinic-was-build`, `petclinic-web-build` 2개 존재
- `petclinic-was-build` → 편집 → 소스: GitHub 리포지토리 연결됨, buildspec: `spring-petclinic-reactjs/buildspec.yml`
- `petclinic-web-build` → 빌드 사양: `spring-petclinic-reactjs/web/buildspec.yml`
- 각 프로젝트 → 서비스 역할: `petclinic-codebuild-role`, 권한 있음(Privileged): **활성화** 확인

---

## 14단계. CodePipeline 생성

> 검색창 → `CodePipeline` → **파이프라인 생성**

### 14-1. WAS 파이프라인

1. 파이프라인 이름: `petclinic-was-pipeline`
2. 실행 모드: `대체됨`
3. 서비스 역할: `기존 역할` → `petclinic-codepipeline-role`
4. **다음**

5. **소스 스테이지**:
   - 소스 공급자: `GitHub(버전 2)`
   - 연결: CodeBuild에서 만든 GitHub 연결 선택
   - 리포지토리: 본인 리포지토리
   - 브랜치: `master`
   - **파이프라인 자동 시작**: **체크 해제** (GitHub Actions가 트리거)
6. **다음**

7. **빌드 스테이지**:
   - 빌드 공급자: `AWS CodeBuild`
   - 프로젝트 이름: `petclinic-was-build`
8. **다음**

9. **배포 스테이지**:
   - 배포 공급자: `Amazon ECS`
   - 클러스터: `petclinic-cluster`
   - 서비스: `petclinic-was-svc`
   - 이미지 정의 파일: `imagedefinitions.json`
10. **다음** → **파이프라인 생성**

### 14-2. WEB 파이프라인

동일하게 생성, 아래만 다름:
- 파이프라인 이름: `petclinic-web-pipeline`
- 빌드 프로젝트: `petclinic-web-build`
- 배포 서비스: `petclinic-web-svc`

**✅ 14단계 완료 확인**
- CodePipeline → `petclinic-was-pipeline`, `petclinic-web-pipeline` 2개 존재
- 각 파이프라인 → **설정** → 파이프라인 자동 시작: **비활성화** 확인 (GitHub Actions가 직접 트리거)
- 각 파이프라인 스테이지: Source → Build → Deploy 3단계 구성 확인
- 서비스 역할: `petclinic-codepipeline-role` 확인

---

## 15단계. CloudTrail 설정

> 누가, 언제, 어떤 AWS API를 호출했는지 감사 로그를 S3에 저장합니다.
> 보안 사고 발생 시 추적 근거가 되며, CloudWatch Logs와 연동하면 실시간 알람도 가능합니다.

### 15-1. CloudTrail용 S3 버킷 생성

1. S3 → **버킷 만들기**:
   - 이름: `petclinic-cloudtrail-<임의숫자>` (전 세계 고유)
   - 리전: `ap-northeast-2`
   - 퍼블릭 액세스 차단: 모두 체크 유지
2. **버킷 만들기**

### 15-2. CloudTrail 생성

3. 검색창 → `CloudTrail` → **추적 생성**
4. 설정:
   - 추적 이름: `petclinic-trail`
   - 스토리지 위치: `기존 S3 버킷 사용` → `petclinic-cloudtrail-<숫자>` 선택
   - 로그 파일 SSE-KMS 암호화: **활성화**
   - AWS KMS 관리형 키: `aws/s3` (AWS 관리형)
5. **CloudWatch Logs 연동** (선택 권장):
   - CloudWatch Logs: **활성화**
   - 로그 그룹 이름: `/aws/cloudtrail/petclinic`
   - 역할 이름: `CloudTrail_CloudWatchLogs_Role` (자동 생성)
6. **이벤트 유형**:
   - 관리 이벤트: **읽기**, **쓰기** 모두 체크
   - 데이터 이벤트: S3 버킷 `petclinic-frontend-*` 추가 (선택)
7. **추적 생성**

**✅ 15단계 완료 확인**
- S3 → `petclinic-cloudtrail-<숫자>` 버킷 존재
- CloudTrail → 추적 → `petclinic-trail` → 상태 **로깅 중** (녹색)
- `petclinic-trail` → 세부 정보 → 스토리지: `petclinic-cloudtrail-<숫자>`, CloudWatch Logs 그룹 `/aws/cloudtrail/petclinic` 연결됨
- S3 → `petclinic-cloudtrail-<숫자>` → 수분 내 `AWSLogs/` 폴더 생성 여부 확인

---

## 16단계. ACM 인증서 발급

> CloudFront용 인증서는 반드시 **버지니아 북부(us-east-1)** 리전에서 발급해야 합니다.

1. 리전을 `us-east-1`으로 변경
2. 검색창 → `Certificate Manager` → **인증서 요청**
3. 설정:
   - 인증서 유형: `퍼블릭 인증서`
   - 도메인 이름: 보유한 도메인 입력 (예: `petclinic.example.com`)
   - 검증 방법: `DNS 검증`
4. **요청** → CNAME 레코드를 도메인 DNS에 등록 → 상태가 `발급됨`이 될 때까지 대기

**✅ 16단계 완료 확인**
- **리전: us-east-1** 확인 (서울 아님)
- ACM → 인증서 목록 → 도메인 이름 확인, 상태 **발급됨(Issued)**
- 발급됨 상태까지 DNS 전파 수분~수십분 소요 (Route53 사용 시 자동 처리 가능)
- 다음 단계 진행 전 ap-northeast-2로 리전 변경

---

## 17단계. WAF 생성

### 17-1. ALB용 WAF (커스텀 헤더 검증)

> 커스텀 헤더 방식: CloudFront가 ALB로 요청 시 비밀 헤더를 추가, WAF가 이 헤더 없는 요청을 차단합니다.
> 이렇게 하면 ALB 보안 그룹을 `0.0.0.0/0`으로 열어도 CloudFront를 통하지 않은 직접 접근은 모두 차단됩니다.

**시크릿 값 생성 (랜덤 UUID):**

메모장에서 UUID를 생성하거나 아래 형식으로 직접 작성:
`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (예: `a1b2c3d4-e5f6-7890-abcd-ef1234567890`)
→ 이 값을 `<SECRET_VALUE>`로 메모

**WAF 생성:**

1. 검색창 → `WAF & Shield` → **Web ACL** → **Web ACL 생성**
2. 설정:
   - 리소스 유형: `Regional resources (ALB, API GW...)`
   - 리전: `ap-northeast-2`
   - 이름: `petclinic-alb-waf`
3. **다음** → 규칙 추가 → **자체 규칙 및 규칙 그룹 추가** → **규칙 빌더**
4. 규칙 설정:
   - 이름: `require-cf-secret-header`
   - 유형: `Regular rule`
   - **조건 추가**:
     - 검사: `Single header`
     - 헤더 이름: `x-origin-verify`
     - 일치 유형: `정확히 일치하지 않음`
     - 값: `<SECRET_VALUE>`
   - 작업: `Block`
5. **규칙 추가** → **다음** → 기본 작업: `Allow` → **다음** → **Web ACL 생성**
6. **연결된 AWS 리소스** 탭 → **AWS 리소스 추가** → `petclinic-alb` 선택

### 17-2. CloudFront용 WAF

> CloudFront WAF는 반드시 **버지니아 북부(us-east-1)** 리전에서 생성해야 합니다.

1. 리전을 `us-east-1`으로 변경
2. WAF → **Web ACL 생성**
3. 설정:
   - 리소스 유형: `CloudFront distributions`
   - 이름: `petclinic-cf-waf`
4. **규칙 추가** → **AWS 관리형 규칙 그룹 추가**:
   - `Core rule set` 체크
   - `Known bad inputs` 체크
5. **다음** → 기본 작업: `Allow` → **Web ACL 생성**
6. CloudFront 생성 시 연결 예정 (15단계에서 처리)

**✅ 17단계 완료 확인**
- WAF (ap-northeast-2) → Web ACL → `petclinic-alb-waf` → **연결된 AWS 리소스** 탭 → `petclinic-alb` 연결됨
- `petclinic-alb-waf` → 규칙 탭 → `require-cf-secret-header` 규칙, 작업 `Block` 확인
- WAF (us-east-1) → Web ACL → `petclinic-cf-waf` 존재 (CRS, Known bad inputs 규칙 포함)
- ALB 직접 접근 테스트 (선택): `http://petclinic-alb-xxx.elb.amazonaws.com` → 403 반환 확인

---

## 18단계. CloudFront 배포 생성

> 리전을 `ap-northeast-2`로 다시 변경

1. 검색창 → `CloudFront` → **배포 생성**

### Origin 1 — S3

2. 원본 도메인: `petclinic-frontend-<숫자>.s3.ap-northeast-2.amazonaws.com`
3. 원본 액세스: `원본 액세스 제어 설정(권장)` → **제어 설정 생성** → **생성**
4. 노란 배너 **정책 복사** 클릭 후 메모

### 기본 캐시 동작

5. 뷰어 프로토콜 정책: `Redirect HTTP to HTTPS`
6. 캐시 정책: `CachingOptimized`
7. 기본 루트 객체: `index.html`

### WAF 연결

8. **AWS WAF 웹 ACL**: `petclinic-cf-waf` 선택

### 커스텀 도메인 (선택)

9. 대체 도메인: 보유 도메인 입력
10. 커스텀 SSL 인증서: 13단계에서 발급한 인증서 선택

11. **배포 생성** → CloudFront 도메인 메모 (`xxxx.cloudfront.net`)

### Origin 2 — ALB 추가 (커스텀 헤더 포함)

12. 생성된 배포 → **원본** 탭 → **원본 생성**
13. 설정:
    - 원본 도메인: ALB DNS 이름 직접 입력
    - 프로토콜: `HTTP만 해당`, 포트: `80`
    - 원본 이름: `petclinic-alb`
    - **커스텀 헤더 추가**:
      - 헤더 이름: `x-origin-verify`
      - 값: `<SECRET_VALUE>` (14단계에서 메모한 값)
14. **원본 저장**

### API 동작 추가

15. **동작** 탭 → **동작 생성**:
    - 경로 패턴: `/petclinic/*`
    - 원본: `petclinic-alb`
    - 허용된 HTTP 방법: `GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE`
    - 캐시 정책: `CachingDisabled`
    - 원본 요청 정책: `AllViewer`
16. **동작 저장**

### S3 버킷 정책 적용

17. S3 → `petclinic-frontend-<숫자>` → **권한** 탭 → **버킷 정책 편집**
18. 14단계 4번에서 복사한 정책 붙여넣기 → **저장**

**✅ 18단계 완료 확인**
- CloudFront → 배포 목록 → 상태 **활성화됨**, 최종 수정 완료
- 배포 → **원본** 탭 → 원본 2개: S3(OAC 적용됨), ALB(`x-origin-verify` 헤더 포함)
- 배포 → **동작** 탭 → `/petclinic/*` 경로 → ALB 원본, `/*` → S3 원본
- 배포 → **일반** 탭 → WAF: `petclinic-cf-waf` 연결됨
- S3 → `petclinic-frontend-<숫자>` → **권한** → 버킷 정책 → CloudFront OAC 정책 저장됨
- CloudFront 도메인 메모 완료 (`xxxx.cloudfront.net`)

---

## 19단계. 코드 수정

### API URL 변경

`spring-petclinic-reactjs/client/webpack.config.prod.js`:

```js
// 변경 전
__API_SERVER_URL__: JSON.stringify('https://api.rapa11.store/petclinic')

// 변경 후
__API_SERVER_URL__: JSON.stringify('https://xxxx.cloudfront.net/petclinic')
```

**✅ 19단계 완료 확인**
- `spring-petclinic-reactjs/client/webpack.config.prod.js` → `__API_SERVER_URL__` 값이 `https://xxxx.cloudfront.net/petclinic` 형태 (실제 CF 도메인)
- `git diff`로 변경 내용 확인

---

## 20단계. GitHub Secrets 등록

GitHub 리포지토리 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret 이름 | 값 | 확인 위치 |
|-------------|-----|----------|
| `AWS_ROLE_ARN` | `arn:aws:iam::<ID>:role/petclinic-github-actions-role` | 3단계 3-5에서 메모 |
| `S3_BUCKET_NAME` | `petclinic-frontend-<숫자>` | 4단계에서 생성한 버킷 |
| `CF_DISTRIBUTION_ID` | `E1XXXXXXXXXX` | CloudFront 콘솔 → 배포 ID |

**✅ 20단계 완료 확인**
- GitHub 리포지토리 → **Settings** → **Secrets and variables** → **Actions** → 시크릿 목록에 3개 존재:
  `AWS_ROLE_ARN` / `S3_BUCKET_NAME` / `CF_DISTRIBUTION_ID`
- 각 시크릿 값이 오타 없이 정확한지 재확인 (특히 ARN 형식, Distribution ID `E`로 시작)

---

## 21단계. 첫 배포

```bash
git add .
git commit -m "initial deploy"
git push origin master
```

**GitHub Actions 탭 확인:**
- `trigger-backend-pipelines` → CodePipeline 2개 트리거
- `deploy-frontend` → S3 sync + CF invalidation

**AWS CodePipeline 콘솔 확인:**
- `petclinic-was-pipeline`: Source → Build → ECS
- `petclinic-web-pipeline`: Source → Build → ECS

**✅ 21단계 완료 확인**
- GitHub → **Actions** 탭 → 최신 워크플로우 실행 → `trigger-backend-pipelines`, `deploy-frontend` 모두 ✅ 녹색
- CodePipeline → `petclinic-was-pipeline` → Source ✅, Build ✅, Deploy ✅ (총 5~10분 소요)
- CodePipeline → `petclinic-web-pipeline` → 동일하게 전체 성공
- S3 → `petclinic-frontend-<숫자>` → 객체 목록에 `index.html` 등 빌드 파일 존재
- 브라우저 → `https://xxxx.cloudfront.net` → PetClinic 메인 화면 표시
- 브라우저 → `https://xxxx.cloudfront.net/petclinic/api/vets` → JSON 응답 (수의사 목록)
- 브라우저 → `http://petclinic-alb-xxx.elb.amazonaws.com` → **403 Forbidden** (WAF 차단 확인)
- CloudWatch → 로그 그룹 → `/ecs/petclinic-was` → 로그 스트림 존재 및 `HikariPool` 초기화 성공 메시지 확인

---

## 배포 후 확인

| 항목 | 확인 방법 |
|------|----------|
| 프론트엔드 | `https://xxxx.cloudfront.net` 브라우저 접속 |
| API | `https://xxxx.cloudfront.net/petclinic/api/vets` |
| ALB 직접 접근 차단 | `http://petclinic-alb-xxx.elb.amazonaws.com/petclinic/api/vets` → 403 반환 확인 |
| 컨테이너 로그 | CloudWatch → 로그 그룹 → `/ecs/petclinic-was` |
| ECS Exec (컨테이너 접속) | ECS 콘솔 → 태스크 → **명령 실행** 탭 |
| EC2 인스턴스 접속 (SSM) | Systems Manager → 세션 관리자 → 인스턴스 선택 → **세션 시작** |
| RDS 연결 확인 | ECS WAS 컨테이너 로그에서 `HikariPool` 연결 성공 메시지 확인 |
| Secrets Manager 주입 확인 | ECS 태스크 → **환경** 탭 → `SPRING_DATASOURCE_USERNAME` 존재 확인 |
| CloudWatch 알람 | CloudWatch → 경보 → `petclinic-*` 알람 상태 확인 |
| CloudTrail 로그 | CloudTrail → 이벤트 기록 → API 호출 목록 확인 |

---

## 롤링 배포 동작 방식

CodePipeline이 배포를 시작하면 ECS가 아래 순서로 자동 처리:

```
1. 새 태스크 시작 (새 이미지)
2. 헬스체크 통과 확인
3. ALB에서 새 태스크로 트래픽 전환
4. 기존 태스크 종료
```

배포 중 서비스 중단 없음. 이전 태스크 정의로 돌아가려면:
ECS → 서비스 → **업데이트** → 이전 태스크 정의 리비전 선택

---

## 수정된 파일 요약

| 파일 | 변경 내용 | 이유 |
|------|----------|------|
| `web/nginx.conf` | `location /` placeholder 제거 | 프론트가 S3/CF 담당, nginx는 API 프록시만 |
| `buildspec.yml` | ECR URI STS 동적 취득 | account ID 코드 노출 방지 |
| `web/buildspec.yml` | ECR URI STS 동적 취득, `imagedefinitions.json` 출력 | 롤링 배포 방식에 맞게 (CodeDeploy 아티팩트 제거) |
| `web/appspec.yml` | 미사용 표시 | Blue/Green → Rolling으로 전환, CodeDeploy 불필요 |
| `aws-deploy.yml` | 빌드/배포 제거 → CodePipeline 트리거 + 프론트 배포 | 역할 명확화: 빌드는 CodeBuild, 배포는 ECS |
| `client/webpack.config.prod.js` | API URL → CF 도메인 | 실제 배포 도메인으로 교체 |
| `db/mysql/initDB.sql` | CREATE DATABASE / GRANT / USE 3줄 제거 | RDS에서 불필요 + MySQL 8.0 GRANT 문법 오류 발생 |
| `application-mysql.properties` | `spring.sql.init.mode=always` 등 주석 해제 | WAS 최초 기동 시 DB 스키마/데이터 자동 초기화 |
